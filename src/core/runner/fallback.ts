import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { writeLog } from "../logs/log-service.js";
import { isModelCompatible, pickCompatibleModel } from "../models/model-filter.js";
import type { CliToolType, Provider } from "../types.js";

export type ResolvedRun = {
  provider: Provider;
  model: string;
  fallbackFrom?: string;
};

export async function resolveProviderForTool(
  tool: CliToolType,
  providerName?: string,
  modelName?: string
): Promise<ResolvedRun> {
  const candidates = await resolveProviderCandidatesForTool(tool, providerName, modelName);
  const resolved = candidates[0];
  if (!resolved) {
    throw new Error("No usable provider/model found. Run `ai status` or `ai doctor`.");
  }

  await writeLog({
    category: "strategy",
    action: "provider_resolved",
    message: `Resolved provider ${resolved.provider.name} with model ${resolved.model}.`,
    metadata: { provider: resolved.provider.name, tool, model: resolved.model, requestedProvider: providerName ?? null, requestedModel: modelName ?? null }
  });
  return resolved;
}

export async function resolveProviderCandidatesForTool(
  tool: CliToolType,
  providerName?: string,
  modelName?: string
): Promise<ResolvedRun[]> {
  const providers = await readProviders();
  if (!providers.length) {
    throw new Error("No providers configured. Run `ai add` first.");
  }

  const cache = await readCache();
  const candidates = providerName
    ? [...providers.filter((provider) => provider.name === providerName), ...providers.filter((provider) => provider.name !== providerName)]
    : providers;

  if (providerName && candidates[0]?.name !== providerName) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  const resolved: ResolvedRun[] = [];
  for (const provider of candidates) {
    const cached = cache.providers[provider.name];
    if (cached?.status === "error") {
      await writeLog({
        level: "warn",
        category: "strategy",
        action: "fallback_skip_provider",
        message: `Skipped provider ${provider.name} because health is error.`,
        metadata: { provider: provider.name, tool, reason: cached.lastError }
      });
      continue;
    }

    const models = cached?.models ?? [];
    const model = resolveModel(tool, provider.model, models, modelName);
    if (!model) {
      await writeLog({
        level: "warn",
        category: "strategy",
        action: "fallback_skip_provider",
        message: `Skipped provider ${provider.name} because no compatible model is available.`,
        metadata: { provider: provider.name, tool, defaultModel: provider.model, cachedModels: models.length }
      });
      continue;
    }

    resolved.push({
      provider,
      model,
      fallbackFrom: providerName && provider.name !== providerName ? providerName : undefined
    });
  }

  return resolved;
}

function resolveModel(tool: CliToolType, defaultModel: string, cachedModels: string[], requestedModel?: string): string | null {
  if (requestedModel) {
    return requestedModel;
  }
  if (defaultModel && isModelCompatible(tool, defaultModel)) {
    return defaultModel;
  }
  if (cachedModels.length) {
    return pickCompatibleModel(tool, "", cachedModels);
  }
  return defaultModel || null;
}
