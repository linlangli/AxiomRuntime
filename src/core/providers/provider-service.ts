import { deleteProviderCache, readCache, renameProviderCache, upsertProviderCache } from "../config/cache-store.js";
import { appendUsageEvent } from "../config/usage-store.js";
import { recordProviderChange } from "../integrations/integration-state.js";
import { writeLog } from "../logs/log-service.js";
import { readProviders, swapProviderLevel, writeProviders } from "../config/providers-store.js";
import { checkCallableModels, checkProvider } from "../models/model-discovery.js";
import { buildUsageEvent } from "../usage/usage-service.js";
import type { Provider, ProviderMode, TokenUsage } from "../types.js";

export type AddProviderInput = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
  mode?: ProviderMode;
};

export async function listProviders(): Promise<Provider[]> {
  return readProviders();
}

export async function addProvider(input: AddProviderInput): Promise<Provider> {
  const providers = await readProviders();
  if (providers.some((provider) => provider.name === input.name.trim())) {
    throw new Error(`Provider already exists: ${input.name}`);
  }

  const draft: Provider = {
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: input.apiKey.trim(),
    mode: input.mode ?? "auto",
    level: providers.length + 1,
    model: input.model?.trim() ?? ""
  };

  const result = await checkProvider(draft);
  const model = draft.model || result.models[0] || "";
  const provider = { ...draft, model };
  await writeProviders([...providers, provider]);
  await upsertProviderCache(provider.name, {
    status: result.status,
    models: result.models,
    lastCheckedAt: result.checkedAt,
    lastError: result.error
  });
  await recordProviderChange({ type: "added", provider: provider.name });
  return provider;
}

export async function updateProvider(providerName: string, patch: Partial<Provider>): Promise<Provider> {
  const providers = await readProviders();
  const current = providers.find((provider) => provider.name === providerName);
  if (!current) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  if (patch.name && patch.name !== providerName && providers.some((provider) => provider.name === patch.name)) {
    throw new Error(`Provider already exists: ${patch.name}`);
  }

  let nextProviders = providers.map((provider) =>
    provider.name === providerName
      ? {
          ...provider,
          ...patch,
          name: patch.name?.trim() || provider.name,
          baseUrl: patch.baseUrl?.trim().replace(/\/+$/, "") || provider.baseUrl,
          apiKey: patch.apiKey?.trim() || provider.apiKey,
          model: patch.model?.trim() ?? provider.model
        }
      : provider
  );

  if (patch.level) {
    nextProviders = swapProviderLevel(nextProviders, patch.name ?? providerName, patch.level);
  }

  await writeProviders(nextProviders);
  const updated = (await readProviders()).find((provider) => provider.name === (patch.name ?? providerName));
  if (!updated) {
    throw new Error("Provider update failed.");
  }

  if (patch.name && patch.name !== providerName) {
    await renameProviderCache(providerName, patch.name);
  }

  if (patch.name || patch.baseUrl || patch.apiKey) {
    await refreshProvider(updated);
  }

  await recordProviderChange({
    type: "updated",
    provider: updated.name,
    previousProvider: updated.name !== providerName ? providerName : undefined
  });
  return updated;
}

export async function deleteProvider(providerName: string): Promise<Provider> {
  const providers = await readProviders();
  const provider = providers.find((item) => item.name === providerName);
  if (!provider) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  await writeProviders(providers.filter((item) => item.name !== providerName));
  await deleteProviderCache(providerName);
  await recordProviderChange({ type: "deleted", provider: provider.name });
  return provider;
}

type RefreshProviderOptions = {
  verifyCallableModels?: boolean;
};

export async function refreshProvider(provider: Provider, options: RefreshProviderOptions = {}): Promise<void> {
  const result = await checkProvider(provider);
  const callable = options.verifyCallableModels && result.models.length
    ? await filterCallableModels(provider, result.models)
    : { models: result.models, failed: 0 };
  const models = callable.models;
  const status = result.status === "ok" && options.verifyCallableModels && !models.length ? "error" : result.status;
  const lastError = status === "error" && options.verifyCallableModels && !models.length
    ? `No callable models found. ${result.error ?? ""}`.trim()
    : result.error;

  await upsertProviderCache(provider.name, {
    status,
    models,
    lastCheckedAt: result.checkedAt,
    lastError
  });
  await writeLog({
    level: status === "ok" ? "info" : "error",
    category: "provider",
    action: "provider_health_check",
    message: `${provider.name}: ${status}${lastError ? ` (${lastError})` : ""}`,
    metadata: {
      provider: provider.name,
      status,
      models: models.length,
      discoveredModels: result.models.length,
      failedCallableModels: callable.failed,
      checkedAt: result.checkedAt,
      verifyCallableModels: Boolean(options.verifyCallableModels)
    }
  });
}

export async function refreshAllProviders(options: RefreshProviderOptions = {}): Promise<void> {
  const providers = await readProviders();
  if (options.verifyCallableModels) {
    for (const provider of providers) {
      await refreshProvider(provider, options);
    }
    return;
  }
  await Promise.all(providers.map((provider) => refreshProvider(provider, options)));
}

export async function getCachedModels(providerName: string): Promise<string[]> {
  const cache = await readCache();
  return cache.providers[providerName]?.models ?? [];
}

async function filterCallableModels(provider: Provider, models: string[]): Promise<{ models: string[]; failed: number }> {
  const results = await checkCallableModels(provider, models);
  for (const result of results) {
    if (result.status === "ok" && result.usage) {
      await recordModelProbeUsage(provider, result.model, result.usage);
    }
  }
  const callableModels = results.filter((result) => result.status === "ok").map((result) => result.model);
  await writeLog({
    level: callableModels.length ? "info" : "warn",
    category: "provider",
    action: "provider_model_probe",
    message: `${provider.name}: ${callableModels.length}/${models.length} callable model(s).`,
    metadata: {
      provider: provider.name,
      callableModels,
      failedModels: results.filter((result) => result.status === "error").map((result) => ({ model: result.model, error: result.error }))
    }
  });
  return { models: callableModels, failed: results.length - callableModels.length };
}

async function recordModelProbeUsage(provider: Provider, model: string, usage: TokenUsage): Promise<void> {
  await appendUsageEvent(buildUsageEvent({
    provider: provider.name,
    tool: "hermes",
    model,
    source: "model_probe",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  }));
}
