import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { isModelCompatible, pickCompatibleModel } from "../models/model-filter.js";
import { refreshAllProviders } from "../providers/provider-service.js";
import { getToolBaseUrl } from "../runner/tool-runner.js";
import { getUsageShare, getWeeklyTokenMap } from "../usage/usage-service.js";
import type { CliToolType, HealthStatus, Provider, ProviderStatus, ToolProviderStatus } from "../types.js";

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
      usageShare: getUsageShare(tokens, allTokens),
      claude: buildToolStatus("claude", provider, cached?.status ?? "unknown", cached?.models ?? []),
      codex: buildToolStatus("codex", provider, cached?.status ?? "unknown", cached?.models ?? [])
    };
  });
}

function buildToolStatus(
  tool: CliToolType,
  provider: Provider,
  health: HealthStatus,
  models: string[]
): ToolProviderStatus {
  const baseUrl = getToolBaseUrl(tool, provider);
  if (health === "error") {
    return {
      state: "provider-error",
      baseUrl,
      model: null,
      note: "provider health error"
    };
  }

  const model = resolveToolModel(tool, provider.model, models);
  if (!model) {
    return {
      state: "no-model",
      baseUrl,
      model: null,
      note: "no compatible cached model"
    };
  }

  return {
    state: "ready",
    baseUrl,
    model,
    note: models.includes(model) ? "model listed" : "default model not verified"
  };
}

function resolveToolModel(tool: CliToolType, defaultModel: string, models: string[]): string | null {
  if (defaultModel && isModelCompatible(tool, defaultModel) && (!models.length || models.includes(defaultModel))) {
    return defaultModel;
  }
  return pickCompatibleModel(tool, "", models);
}
