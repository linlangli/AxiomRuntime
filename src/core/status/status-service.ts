import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { refreshAllProviders } from "../providers/provider-service.js";
import { getUsageShare, getWeeklyTokenMap } from "../usage/usage-service.js";
import type { ProviderStatus } from "../types.js";

export async function getProviderStatuses(options: { refresh?: boolean } = {}): Promise<ProviderStatus[]> {
  if (options.refresh) {
    await refreshAllProviders();
  }

  const [providers, cache, weeklyTokens] = await Promise.all([readProviders(), readCache(), getWeeklyTokenMap()]);
  const allTokens = [...weeklyTokens.values()].reduce((sum, value) => sum + value, 0);

  return providers.map((provider) => {
    const cached = cache.providers[provider.name];
    const tokens = weeklyTokens.get(provider.name) ?? 0;
    return {
      ...provider,
      health: cached?.status ?? "unknown",
      models: cached?.models ?? [],
      lastCheckedAt: cached?.lastCheckedAt ?? null,
      lastError: cached?.lastError ?? null,
      weeklyTokens: tokens,
      usageShare: getUsageShare(tokens, allTokens)
    };
  });
}
