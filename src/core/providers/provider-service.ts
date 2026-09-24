import { buildProviderHealthCache, deleteProviderCache, readCache, renameProviderCache, upsertProviderCache } from "../config/cache-store.js";
import { appendUsageEvent } from "../config/usage-store.js";
import { recordProviderChange } from "../integrations/integration-state.js";
import { writeLog } from "../logs/log-service.js";
import { readProviders, swapProviderLevel, updateProviders } from "../config/providers-store.js";
import { checkCallableModels, checkProvider, probeProviderConfiguration } from "../models/model-discovery.js";
import { isModelCompatible } from "../models/model-filter.js";
import { buildUsageEvent } from "../usage/usage-service.js";
import type { CliToolType, Provider, ProviderMode, ProviderToolCheck, TokenUsage } from "../types.js";

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

  const result = await probeProviderConfiguration(draft);
  if (result.status !== "ok" || !result.models.length) {
    throw new Error(`Provider configuration probe failed: ${result.error ?? "no usable models found"}`);
  }
  if (draft.model && !result.models.includes(draft.model)) {
    throw new Error(`Configured model was not found or could not be verified: ${draft.model}`);
  }
  const configuredDraft = result.provider;
  const model = draft.model || result.models[0]!;
  const normalizedProviders = await updateProviders((current) => {
    if (current.some((provider) => provider.name === draft.name)) {
      throw new Error(`Provider already exists: ${draft.name}`);
    }
    return [...current, { ...configuredDraft, level: current.length + 1, model }];
  });
  const provider = normalizedProviders.find((item) => item.name === draft.name);
  if (!provider) {
    throw new Error("Provider add failed.");
  }
  await upsertProviderCache(provider.name, buildProviderHealthCache(undefined, {
    status: result.status,
    models: result.models,
    lastCheckedAt: result.checkedAt,
    lastError: result.error
  }));
  await recordSuccessfulProbeUsage(provider, result.modelChecks);
  await recordProviderChange({ type: "added", provider: provider.name });
  return provider;
}

export async function updateProvider(providerName: string, patch: Partial<Provider>): Promise<Provider> {
  const existingProviders = await readProviders();
  const existing = existingProviders.find((provider) => provider.name === providerName);
  if (!existing) throw new Error(`Provider not found: ${providerName}`);
  const targetName = patch.name?.trim() || providerName;
  if (targetName !== providerName && existingProviders.some((provider) => provider.name === targetName)) {
    throw new Error(`Provider already exists: ${targetName}`);
  }
  let validatedPatch = patch;
  let probeResult: Awaited<ReturnType<typeof probeProviderConfiguration>> | null = null;
  if (patch.baseUrl || patch.apiKey) {
    const candidate: Provider = {
      ...existing,
      ...patch,
      name: targetName,
      baseUrl: patch.baseUrl?.trim().replace(/\/+$/, "") || existing.baseUrl,
      apiKey: patch.apiKey?.trim() || existing.apiKey,
      requestProfile: undefined
    };
    probeResult = await probeProviderConfiguration(candidate);
    if (probeResult.status !== "ok" || !probeResult.models.length) {
      throw new Error(`Provider configuration probe failed: ${probeResult.error ?? "no usable models found"}`);
    }
    validatedPatch = {
      ...patch,
      baseUrl: probeResult.provider.baseUrl,
      apiKey: probeResult.provider.apiKey,
      requestProfile: probeResult.provider.requestProfile,
      model: patch.model && probeResult.models.includes(patch.model)
        ? patch.model
        : probeResult.models.includes(existing.model) ? existing.model : probeResult.models[0]
    };
  }
  const normalizedProviders = await updateProviders((providers) => {
    const current = providers.find((provider) => provider.name === providerName);
    if (!current) {
      throw new Error(`Provider not found: ${providerName}`);
    }
    if (targetName !== providerName && providers.some((provider) => provider.name === targetName)) {
      throw new Error(`Provider already exists: ${targetName}`);
    }

    let nextProviders = providers.map((provider) =>
      provider.name === providerName
        ? {
            ...provider,
            ...validatedPatch,
            name: targetName,
            baseUrl: validatedPatch.baseUrl?.trim().replace(/\/+$/, "") || provider.baseUrl,
            apiKey: validatedPatch.apiKey?.trim() || provider.apiKey,
            model: validatedPatch.model?.trim() ?? provider.model
          }
        : provider
    );

    if (patch.level) {
      nextProviders = swapProviderLevel(nextProviders, targetName, patch.level);
    }

    return nextProviders;
  });
  const updated = normalizedProviders.find((provider) => provider.name === targetName);
  if (!updated) {
    throw new Error("Provider update failed.");
  }

  if (patch.name && patch.name !== providerName) {
    await renameProviderCache(providerName, patch.name);
  }

  if (probeResult) {
    await upsertProviderCache(updated.name, buildProviderHealthCache(undefined, {
      status: "ok",
      models: probeResult.models,
      lastCheckedAt: probeResult.checkedAt,
      lastError: null
    }));
    await recordSuccessfulProbeUsage(updated, probeResult.modelChecks);
  }

  await recordProviderChange({
    type: "updated",
    provider: updated.name,
    previousProvider: updated.name !== providerName ? providerName : undefined
  });
  return updated;
}

export async function deleteProvider(providerName: string): Promise<Provider> {
  const deleted: { value?: Provider } = {};
  await updateProviders((providers) => {
    deleted.value = providers.find((item) => item.name === providerName);
    if (!deleted.value) {
      throw new Error(`Provider not found: ${providerName}`);
    }
    return providers.filter((item) => item.name !== providerName);
  });
  if (!deleted.value) {
    throw new Error(`Provider not found: ${providerName}`);
  }
  await deleteProviderCache(providerName);
  await recordProviderChange({ type: "deleted", provider: deleted.value.name });
  return deleted.value;
}

type RefreshProviderOptions = {
  verifyCallableModels?: boolean;
  verifyRepresentativeModels?: boolean;
};

export async function refreshProvider(provider: Provider, options: RefreshProviderOptions = {}): Promise<void> {
  const result = await checkProvider(provider);
  const representative = options.verifyRepresentativeModels && result.status === "ok"
    ? await verifyRepresentativeModels(provider, result.models, result.checkedAt)
    : null;
  const callable = options.verifyCallableModels && !representative && result.models.length
    ? await filterCallableModels(provider, result.models)
    : { models: result.models, failed: 0, attempts: 0, durationMs: 0, retryErrors: [] as string[] };
  const models = callable.models;
  const representativeChecks = representative ? Object.values(representative.toolChecks) : [];
  const applicableChecks = representativeChecks.filter((check) => check?.status !== "not_applicable");
  const representativeFailed = Boolean(representative && applicableChecks.length && !applicableChecks.some((check) => check?.status === "ok"));
  const status = result.status === "ok" && ((options.verifyCallableModels && !models.length) || representativeFailed)
    ? "error"
    : result.status;
  const lastError = representativeFailed
    ? "No representative Claude or Codex model passed a real request."
    : status === "error" && options.verifyCallableModels && !models.length
    ? `No callable models found. ${result.error ?? ""}`.trim()
    : result.error;

  const cache = await readCache();
  await upsertProviderCache(provider.name, buildProviderHealthCache(cache.providers[provider.name], {
    status,
    models,
    lastCheckedAt: result.checkedAt,
    lastError,
    ...(representative ? { toolChecks: representative.toolChecks } : {})
  }));
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
      verifyCallableModels: Boolean(options.verifyCallableModels),
      verifyRepresentativeModels: Boolean(options.verifyRepresentativeModels),
      toolChecks: representative?.toolChecks ?? null,
      attempts: (result.attempts ?? 0) + callable.attempts + (representative?.attempts ?? 0),
      discoveryAttempts: result.attempts ?? null,
      callableAttempts: callable.attempts,
      durationMs: (result.durationMs ?? 0) + callable.durationMs + (representative?.durationMs ?? 0),
      discoveryDurationMs: result.durationMs ?? null,
      callableDurationMs: callable.durationMs,
      retryErrors: [...(result.retryErrors ?? []), ...callable.retryErrors, ...(representative?.retryErrors ?? [])].slice(-8)
    }
  });
}

export async function refreshAllProviders(options: RefreshProviderOptions = {}): Promise<void> {
  const providers = await readProviders();
  if (options.verifyCallableModels || options.verifyRepresentativeModels) {
    await mapWithConcurrency(providers, 2, (provider) => refreshProvider(provider, options));
    return;
  }
  await Promise.all(providers.map((provider) => refreshProvider(provider, options)));
}

async function verifyRepresentativeModels(
  provider: Provider,
  models: string[],
  checkedAt: string
): Promise<{
  toolChecks: Partial<Record<CliToolType, ProviderToolCheck>>;
  attempts: number;
  durationMs: number;
  retryErrors: string[];
}> {
  const representatives = (["claude", "codex"] as const).map((tool) => ({
    tool,
    model: selectRepresentativeModel(tool, provider.model, models)
  }));
  const selectedModels = representatives.flatMap(({ model }) => model ? [model] : []);
  const results = await checkCallableModels(provider, selectedModels, { maxAttempts: 1 });
  const resultByModel = new Map(results.map((result) => [result.model, result]));
  const toolChecks: Partial<Record<CliToolType, ProviderToolCheck>> = {};

  for (const { tool, model } of representatives) {
    if (!model) {
      toolChecks[tool] = {
        status: "not_applicable",
        model: null,
        checkedAt,
        error: null,
        attempts: 0,
        durationMs: 0
      };
      continue;
    }
    const result = resultByModel.get(model)!;
    toolChecks[tool] = {
      status: result.status,
      model,
      checkedAt,
      error: result.error,
      attempts: result.attempts ?? 0,
      durationMs: result.durationMs ?? 0
    };
    if (result.status === "ok" && result.usage) {
      await recordModelProbeUsage(provider, model, result.usage);
    }
  }

  return {
    toolChecks,
    attempts: results.reduce((sum, result) => sum + (result.attempts ?? 0), 0),
    durationMs: results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
    retryErrors: results.flatMap((result) => result.retryErrors ?? [])
  };
}

function selectRepresentativeModel(tool: CliToolType, defaultModel: string, models: string[]): string | null {
  if (defaultModel && models.includes(defaultModel) && isModelCompatible(tool, defaultModel)) return defaultModel;
  return models.find((model) => isModelCompatible(tool, model)) ?? null;
}

export async function getCachedModels(providerName: string): Promise<string[]> {
  const cache = await readCache();
  return cache.providers[providerName]?.models ?? [];
}

async function filterCallableModels(provider: Provider, models: string[]): Promise<{
  models: string[];
  failed: number;
  attempts: number;
  durationMs: number;
  retryErrors: string[];
}> {
  const results = await checkCallableModels(provider, models);
  for (const result of results) {
    if (result.status === "ok" && result.usage) {
      await recordModelProbeUsage(provider, result.model, result.usage);
    }
  }
  const callableModels = results.filter((result) => result.status === "ok").map((result) => result.model);
  const retryErrors = results.flatMap((result) => result.retryErrors ?? []);
  await writeLog({
    level: callableModels.length ? "info" : "warn",
    category: "provider",
    action: "provider_model_probe",
    message: `${provider.name}: ${callableModels.length}/${models.length} callable model(s).`,
    metadata: {
      provider: provider.name,
      callableModels,
      failedModels: results.filter((result) => result.status === "error").map((result) => ({
        model: result.model,
        error: result.error,
        attempts: result.attempts ?? null,
        durationMs: result.durationMs ?? null
      })),
      attempts: results.reduce((sum, result) => sum + (result.attempts ?? 0), 0),
      durationMs: results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
      retryErrors: retryErrors.slice(-8)
    }
  });
  return {
    models: callableModels,
    failed: results.length - callableModels.length,
    attempts: results.reduce((sum, result) => sum + (result.attempts ?? 0), 0),
    durationMs: results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
    retryErrors
  };
}

async function recordModelProbeUsage(provider: Provider, model: string, usage: TokenUsage): Promise<void> {
  await appendUsageEvent(buildUsageEvent({
    provider: provider.name,
    tool: "provider",
    model,
    source: "model_probe",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  }));
}

async function recordSuccessfulProbeUsage(
  provider: Provider,
  checks: Array<{ model: string; status: "ok" | "error"; usage?: TokenUsage }>
): Promise<void> {
  const recorded = new Set<string>();
  for (const check of checks) {
    if (check.status !== "ok" || !check.usage || recorded.has(check.model)) continue;
    recorded.add(check.model);
    await recordModelProbeUsage(provider, check.model, check.usage);
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await mapper(items[currentIndex]!);
    }
  });
  await Promise.all(workers);
}
