import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
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
      continue;
    }

    const model = modelName || pickCompatibleModel(tool, provider.model, cached?.models ?? []) || provider.model;
    if (!model) {
      continue;
    }

    return {
      provider,
      model,
      fallbackFrom: providerName && provider.name !== providerName ? providerName : undefined
    };
  }

  throw new Error("No usable provider/model found. Run `ai status` or `ai doctor`.");
}
