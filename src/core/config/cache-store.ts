import { getCachePath } from "./paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json-store.js";
import type { CacheFile, CliToolType, HealthStatus, ProviderCache, ProviderToolCheck } from "../types.js";

const EMPTY_CACHE: CacheFile = { providers: {} };
const PROVIDER_CIRCUIT_FAILURE_THRESHOLD = 3;
const PROVIDER_CIRCUIT_OPEN_MS = 10 * 60 * 1000;
const DEFAULT_HEALTH_SCORE = 50;
const MAX_HEALTH_SCORE = 100;
const HEALTH_SCORE_FAILURE_STEP = 35;

export async function readCache(): Promise<CacheFile> {
  const cache = await readJsonFile<CacheFile>(getCachePath(), EMPTY_CACHE);
  return normalizeCache(cache);
}

export async function writeCache(cache: CacheFile): Promise<void> {
  await writeJsonFile(getCachePath(), normalizeCache(cache));
}

export async function upsertProviderCache(providerName: string, providerCache: ProviderCache): Promise<void> {
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => {
    const next = normalizeCache(cache);
    next.providers[providerName] = normalizeProviderCache(providerCache);
    return next;
  });
}

export async function recordProviderRuntimeSuccess(providerName: string): Promise<ProviderCache> {
  const checkedAt = new Date().toISOString();
  let updated: ProviderCache | null = null;
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => {
    const next = normalizeCache(cache);
    updated = applyProviderHealth(next.providers[providerName], {
      status: "ok",
      models: next.providers[providerName]?.models ?? [],
      lastCheckedAt: checkedAt,
      lastError: null
    });
    next.providers[providerName] = updated;
    return next;
  });
  return updated!;
}

export async function recordProviderRuntimeFailure(providerName: string, error: unknown): Promise<ProviderCache> {
  const checkedAt = new Date().toISOString();
  const lastError = summarizeHealthError(error);
  let updated: ProviderCache | null = null;
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => {
    const next = normalizeCache(cache);
    const previous = next.providers[providerName] ? normalizeProviderCache(next.providers[providerName]) : undefined;
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const circuitOpenUntil = consecutiveFailures >= PROVIDER_CIRCUIT_FAILURE_THRESHOLD
      ? new Date(Date.now() + PROVIDER_CIRCUIT_OPEN_MS).toISOString()
      : null;
    updated = {
      status: circuitOpenUntil ? "error" : previous?.status ?? "unknown",
      models: previous?.models ?? [],
      lastCheckedAt: checkedAt,
      lastError,
      consecutiveFailures,
      lastFailureAt: checkedAt,
      circuitOpenUntil,
      healthScore: clampHealthScore((previous?.healthScore ?? DEFAULT_HEALTH_SCORE) - HEALTH_SCORE_FAILURE_STEP)
    };
    next.providers[providerName] = updated;
    return next;
  });
  return updated!;
}

export function buildProviderHealthCache(previous: ProviderCache | undefined, next: ProviderCache): ProviderCache {
  return applyProviderHealth(previous, normalizeProviderCache(next));
}

export function isProviderCircuitOpen(providerCache: ProviderCache | undefined, now = Date.now()): boolean {
  if (!providerCache?.circuitOpenUntil) return false;
  const openUntil = Date.parse(providerCache.circuitOpenUntil);
  return Number.isFinite(openUntil) && openUntil > now;
}

export async function renameProviderCache(from: string, to: string): Promise<void> {
  if (from === to) return;
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => {
    const next = normalizeCache(cache);
    if (next.providers[from]) {
      next.providers[to] = next.providers[from];
      delete next.providers[from];
    }
    if (next.lastSelection?.provider === from) {
      next.lastSelection.provider = to;
    }
    return next;
  });
}

export async function deleteProviderCache(providerName: string): Promise<void> {
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => {
    const next = normalizeCache(cache);
    delete next.providers[providerName];
    if (next.lastSelection?.provider === providerName) {
      delete next.lastSelection;
    }
    return next;
  });
}

export async function saveLastSelection(tool: CliToolType, provider: string, model: string): Promise<void> {
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => ({
    ...normalizeCache(cache),
    lastSelection: {
      tool,
      provider,
      model,
      usedAt: new Date().toISOString()
    }
  }));
}

function normalizeCache(cache: CacheFile): CacheFile {
  const providers: Record<string, ProviderCache> = {};
  for (const [name, value] of Object.entries(cache.providers ?? {})) {
    providers[name] = normalizeProviderCache(value);
  }
  return {
    providers,
    lastSelection: cache.lastSelection
  };
}

function applyProviderHealth(previous: ProviderCache | undefined, next: ProviderCache): ProviderCache {
  const normalizedPrevious = previous ? normalizeProviderCache(previous) : undefined;
  const normalizedNext = normalizeProviderCache(next);
  if (!normalizedNext.toolChecks && normalizedPrevious?.toolChecks) {
    normalizedNext.toolChecks = normalizedPrevious.toolChecks;
  }
  const previousScore = normalizedPrevious?.healthScore ?? DEFAULT_HEALTH_SCORE;

  if (normalizedNext.status === "ok") {
    // 一次真实成功比历史累计更有说服力：直接回满分，否则被误判扣出来的坑（失败 -35、成功 +25）
    // 永远填不平，healthScore 会长期停在低位，作为诊断信号不可信。
    return {
      ...normalizedNext,
      consecutiveFailures: 0,
      lastFailureAt: null,
      circuitOpenUntil: null,
      healthScore: MAX_HEALTH_SCORE
    };
  }

  if (normalizedNext.status === "error") {
    const consecutiveFailures = (normalizedPrevious?.consecutiveFailures ?? 0) + 1;
    return {
      ...normalizedNext,
      consecutiveFailures,
      lastFailureAt: normalizedNext.lastCheckedAt,
      circuitOpenUntil: consecutiveFailures >= PROVIDER_CIRCUIT_FAILURE_THRESHOLD
        ? new Date(Date.now() + PROVIDER_CIRCUIT_OPEN_MS).toISOString()
        : null,
      healthScore: clampHealthScore(previousScore - HEALTH_SCORE_FAILURE_STEP)
    };
  }

  return {
    ...normalizedNext,
    consecutiveFailures: normalizedPrevious?.consecutiveFailures ?? 0,
    lastFailureAt: normalizedPrevious?.lastFailureAt ?? null,
    circuitOpenUntil: normalizedPrevious?.circuitOpenUntil ?? null,
    healthScore: clampHealthScore(previousScore)
  };
}

function normalizeProviderCache(value: ProviderCache): ProviderCache {
  const status = normalizeHealthStatus(value.status);
  const toolChecks = normalizeToolChecks(value.toolChecks);
  return {
    status,
    models: Array.isArray(value.models) ? value.models.map(String).filter(Boolean) : [],
    lastCheckedAt: normalizeNullableString(value.lastCheckedAt),
    lastError: normalizeNullableString(value.lastError),
    consecutiveFailures: normalizeNonNegativeInteger(value.consecutiveFailures),
    lastFailureAt: normalizeNullableString(value.lastFailureAt),
    circuitOpenUntil: normalizeNullableString(value.circuitOpenUntil),
    healthScore: clampHealthScore(
      typeof value.healthScore === "number" && Number.isFinite(value.healthScore)
        ? value.healthScore
        : status === "ok"
          ? 100
          : status === "error"
            ? 0
            : DEFAULT_HEALTH_SCORE
    ),
    ...(toolChecks ? { toolChecks } : {})
  };
}

function normalizeToolChecks(value: ProviderCache["toolChecks"]): ProviderCache["toolChecks"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result: Partial<Record<CliToolType, ProviderToolCheck>> = {};
  for (const tool of ["claude", "codex"] as const) {
    const check = value[tool];
    if (!check || typeof check !== "object") continue;
    result[tool] = {
      status: check.status === "ok" || check.status === "error" || check.status === "unknown" || check.status === "not_applicable"
        ? check.status
        : "error",
      model: normalizeNullableString(check.model),
      checkedAt: normalizeNullableString(check.checkedAt) ?? new Date(0).toISOString(),
      error: normalizeNullableString(check.error),
      attempts: normalizeNonNegativeInteger(check.attempts),
      durationMs: normalizeNonNegativeInteger(check.durationMs)
    };
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeHealthStatus(value: unknown): HealthStatus {
  return value === "ok" || value === "error" || value === "unknown" ? value : "unknown";
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeNonNegativeInteger(value: unknown): number {
  const numberValue = Number(value ?? 0);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : 0;
}

function clampHealthScore(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HEALTH_SCORE;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function summarizeHealthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Provider failed.");
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "Provider failed.";
}
