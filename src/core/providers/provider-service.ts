import { readCache, renameProviderCache, upsertProviderCache } from "../config/cache-store.js";
import { writeLog } from "../logs/log-service.js";
import { readProviders, swapProviderLevel, writeProviders } from "../config/providers-store.js";
import { checkProvider } from "../models/model-discovery.js";
import type { Provider, ProviderMode } from "../types.js";

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

  return updated;
}

export async function refreshProvider(provider: Provider): Promise<void> {
  const result = await checkProvider(provider);
  await upsertProviderCache(provider.name, {
    status: result.status,
    models: result.models,
    lastCheckedAt: result.checkedAt,
    lastError: result.error
  });
  await writeLog({
    level: result.status === "ok" ? "info" : "error",
    category: "provider",
    action: "provider_health_check",
    message: `${provider.name}: ${result.status}${result.error ? ` (${result.error})` : ""}`,
    metadata: { provider: provider.name, status: result.status, models: result.models.length, checkedAt: result.checkedAt }
  });
}

export async function refreshAllProviders(): Promise<void> {
  const providers = await readProviders();
  await Promise.all(providers.map((provider) => refreshProvider(provider)));
}

export async function getCachedModels(providerName: string): Promise<string[]> {
  const cache = await readCache();
  return cache.providers[providerName]?.models ?? [];
}
