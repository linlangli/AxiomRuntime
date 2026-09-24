import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { isModelCompatible, pickCompatibleModel } from "../models/model-filter.js";
import { refreshAllProviders } from "../providers/provider-service.js";
import { getToolBaseUrl } from "../runner/tool-runner.js";
import { getUsageShare, getWeeklyTokenMap } from "../usage/usage-service.js";
import type { CliToolType, HealthStatus, Provider, ProviderStatus, ProviderToolCheck, ToolProviderStatus } from "../types.js";

export async function getProviderStatuses(options: { refresh?: boolean } = {}): Promise<ProviderStatus[]> {
  if (options.refresh) {
    await refreshAllProviders({ verifyRepresentativeModels: true });
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
      claude: buildToolStatus(
        "claude",
        provider,
        cached?.status ?? "unknown",
        cached?.models ?? [],
        cached?.toolChecks?.claude,
        cached?.lastError ?? null
      ),
      codex: buildToolStatus(
        "codex",
        provider,
        cached?.status ?? "unknown",
        cached?.models ?? [],
        cached?.toolChecks?.codex,
        cached?.lastError ?? null
      )
    };
  });
}

function buildToolStatus(
  tool: CliToolType,
  provider: Provider,
  health: HealthStatus,
  models: string[],
  check: ProviderToolCheck | undefined,
  providerError: string | null
): ToolProviderStatus {
  const baseUrl = getToolBaseUrl(tool, provider);
  const model = resolveToolModel(tool, provider.model, models);
  if (health === "error" && !check) {
    return {
      state: "provider-error",
      baseUrl,
      model,
      note: providerError ?? "provider health error",
      checkedAt: null,
      attempts: 0,
      durationMs: 0
    };
  }

  if (!model) {
    return {
      state: "no-model",
      baseUrl,
      model: null,
      note: "no compatible model discovered; no token probe sent",
      checkedAt: check?.checkedAt ?? null,
      attempts: 0,
      durationMs: 0
    };
  }

  if (check?.status === "error") {
    return {
      state: "provider-error",
      baseUrl,
      model: check?.model ?? model,
      note: check?.error ?? providerError ?? "live protocol check failed",
      checkedAt: check?.checkedAt ?? null,
      attempts: check?.attempts ?? 0,
      durationMs: check?.durationMs ?? 0
    };
  }

  if (!check) {
    return {
      state: "unverified",
      baseUrl,
      model,
      note: "model discovered but no live protocol check is cached",
      checkedAt: null,
      attempts: 0,
      durationMs: 0
    };
  }

  if (check.status === "not_applicable") {
    return {
      state: "no-model",
      baseUrl,
      model: null,
      note: "no compatible model discovered; no token probe sent",
      checkedAt: check.checkedAt,
      attempts: check.attempts,
      durationMs: check.durationMs
    };
  }

  return {
    state: "ready",
    baseUrl,
    model: check.model ?? model,
    note: "live 1-token protocol check passed",
    checkedAt: check.checkedAt,
    attempts: check.attempts,
    durationMs: check.durationMs
  };
}

function resolveToolModel(tool: CliToolType, defaultModel: string, models: string[]): string | null {
  if (defaultModel && isModelCompatible(tool, defaultModel) && (!models.length || models.includes(defaultModel))) {
    return defaultModel;
  }
  return pickCompatibleModel(tool, "", models);
}
