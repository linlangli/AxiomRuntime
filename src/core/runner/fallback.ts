import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { writeLog } from "../logs/log-service.js";
import { pickCompatibleModel } from "../models/model-filter.js";
import type { Provider, ToolType } from "../types.js";

export type ResolvedRun = {
  provider: Provider;
  model: string;
  fallbackFrom?: string;
};

export async function resolveProviderForTool(
  tool: ToolType,
  providerName?: string,
  modelName?: string
): Promise<ResolvedRun> {
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

    const model = modelName || pickCompatibleModel(tool, provider.model, cached?.models ?? []) || provider.model;
    if (!model) {
      await writeLog({
        level: "warn",
        category: "strategy",
        action: "fallback_skip_provider",
        message: `Skipped provider ${provider.name} because no model is available.`,
        metadata: { provider: provider.name, tool }
      });
      continue;
    }

    await writeLog({
      category: "strategy",
      action: "provider_resolved",
      message: `Resolved provider ${provider.name} with model ${model}.`,
      metadata: { provider: provider.name, tool, model, requestedProvider: providerName ?? null, requestedModel: modelName ?? null }
    });

    return {
      provider,
      model,
      fallbackFrom: providerName && provider.name !== providerName ? providerName : undefined
    };
  }

  throw new Error("No usable provider/model found. Run `ai status` or `ai doctor`.");
}
