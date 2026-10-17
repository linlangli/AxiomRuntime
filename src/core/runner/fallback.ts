import { isProviderCircuitOpen, readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
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

export async function resolveExactProviderForTool(
  tool: CliToolType,
  providerName: string,
  modelName?: string
): Promise<ResolvedRun> {
  const providers = await readProviders();
  const provider = providers.find((candidate) => candidate.name === providerName);
  if (!provider) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  const cache = await readCache();
  const models = cache.providers[provider.name]?.models ?? [];
  const model = resolveModel(tool, provider.model, models, modelName);
  if (!model) {
    throw new Error(`Provider ${providerName} does not offer a compatible ${tool} model.`);
  }

  await writeLog({
    category: "strategy",
    action: "provider_resolved_exact",
    message: `Resolved exact provider ${provider.name} with model ${model}.`,
    metadata: { provider: provider.name, tool, model, requestedProvider: providerName, requestedModel: modelName ?? null }
  });
  return { provider, model };
}

export async function resolveProviderCandidatesForTool(
  tool: CliToolType,
  providerName?: string,
  modelName?: string,
  traceId?: string
): Promise<ResolvedRun[]> {
  const providers = await readProviders();
  if (!providers.length) {
    throw new Error("No providers configured. Run `ai add` first.");
  }

  const [cache, runtimeConfig] = await Promise.all([readCache(), loadRuntimeConfig()]);
  const selected = providerName ? providers.find((provider) => provider.name === providerName) : undefined;
  const automaticProviders = providers.filter((provider) => provider.level > 0);
  const candidates = selected
    ? selected.level === 0
      ? [selected]
      : [selected, ...automaticProviders.filter((provider) => provider.name !== selected.name)]
    : automaticProviders;

  // 全局关闭自动降级：折叠到单候选，只尝试选定（或默认 level:1）的 Provider，
  // 失败即报错，不再轮转。请求级与会话级的 fallback 都从这条候选链派生，此处折叠即可一并关闭。
  const failoverDisabled = runtimeConfig.failoverDisabled === true;
  const scoped = failoverDisabled ? candidates.slice(0, 1) : candidates;
  if (failoverDisabled) {
    await writeLog({
      level: "info",
      category: "strategy",
      action: "failover_disabled",
      message: `Provider auto-failover is disabled; only ${scoped[0]?.name ?? "(none)"} will be attempted.`,
      ...(traceId ? { traceId } : {}),
      metadata: { tool, provider: scoped[0]?.name ?? null }
    });
  }

  if (providerName && scoped[0]?.name !== providerName) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  const resolved: ResolvedRun[] = [];
  for (const provider of scoped) {
    const cached = cache.providers[provider.name];
    const explicitlySelected = providerName === provider.name;
    if (!failoverDisabled && !explicitlySelected && isProviderCircuitOpen(cached)) {
      await writeLog({
        level: "warn",
        category: "strategy",
        action: "fallback_skip_provider",
        message: `Skipped provider ${provider.name} because circuit breaker is open.`,
        ...(traceId ? { traceId } : {}),
        metadata: { provider: provider.name, level: provider.level, tool, reason: "circuit_open", circuitOpenUntil: cached?.circuitOpenUntil ?? null }
      });
      continue;
    }

    // Runtime-opened circuits become half-open after their cooldown. A stale
    // status=error must not keep a provider disabled forever after the timer.
    if (!failoverDisabled && !explicitlySelected && cached?.status === "error" && !cached.circuitOpenUntil) {
      await writeLog({
        level: "warn",
        category: "strategy",
        action: "fallback_skip_provider",
        message: `Skipped provider ${provider.name} because health is error.`,
        ...(traceId ? { traceId } : {}),
        metadata: { provider: provider.name, level: provider.level, tool, reason: "health_error", lastError: cached.lastError ?? null }
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
        ...(traceId ? { traceId } : {}),
        metadata: { provider: provider.name, level: provider.level, tool, reason: "no_compatible_model", defaultModel: provider.model, cachedModels: models.length }
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
    if (!isModelCompatible(tool, requestedModel)) {
      return null;
    }
    // Only offer the requested model when the provider's known catalog serves
    // it; otherwise drop this provider from the rotation instead of guaranteeing
    // an upstream model_not_found. An unknown/never-probed catalog is allowed
    // through optimistically so newly added providers still get a chance.
    if (cachedModels.length && !cachedModels.includes(requestedModel)) {
      return null;
    }
    return requestedModel;
  }
  if (defaultModel && isModelCompatible(tool, defaultModel)) {
    return defaultModel;
  }
  if (cachedModels.length) {
    return pickCompatibleModel(tool, "", cachedModels);
  }
  return null;
}
