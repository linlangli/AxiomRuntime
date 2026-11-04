import fs from "node:fs/promises";
import { parse } from "smol-toml";
import os from "node:os";
import path from "node:path";
import { readCache } from "../config/cache-store.js";
import { readUsage } from "../config/usage-store.js";
import { readRecentLogs } from "../logs/log-service.js";
import { getProviderStatuses } from "../status/status-service.js";
import { listRecentSessions } from "../sessions/session-service.js";
import { estimateTokenCostUsd, readModelPricing } from "../usage/pricing.js";
import { getConfigRoot } from "../config/paths.js";
import { getLocalSettings } from "./local-settings.js";
import { projectHistoryLogs, summarizeCalls } from "./execution-history.js";
import { providerIdForName } from "../integrations/codex-provider-config.js";
import { syncCodexAppUsage } from "../usage/codex-app-usage.js";

export async function getWebDashboard() {
  const codexUsage = await syncCodexAppUsage();
  const [statuses, cache, usage, logs, sessions, pricing, codex, settings] = await Promise.all([
    getProviderStatuses(), readCache(), readUsage(), readRecentLogs(300), listRecentSessions(30), readModelPricing(), readCodexConfigSummary(), getLocalSettings()
  ]);
  const providers = statuses.map(({ apiKey, requestProfile, ...status }) => ({
    ...status,
    credentialConfigured: Boolean(apiKey),
    requestProfile: requestProfile ? {
      discoveryAuth: requestProfile.discoveryAuth,
      openaiAuth: requestProfile.openaiAuth,
      anthropicAuth: requestProfile.anthropicAuth,
      verifiedProtocols: requestProfile.verifiedProtocols
    } : null,
    healthScore: cache.providers[status.name]?.healthScore ?? null,
    circuitOpenUntil: cache.providers[status.name]?.circuitOpenUntil ?? null
  }));
  const days = new Map<string, { date: string; inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number; unpricedEvents: number }>();
  const byProvider = new Map<string, {
    provider: string;
    totalTokens: number;
    estimatedCostUsd: number;
    unpricedEvents: number;
    models: Map<string, { model: string; totalTokens: number; lastUsedAt: string }>;
    days: Map<string, { date: string; inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number; unpricedEvents: number }>;
  }>();
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let unpricedEvents = 0;
  for (const event of usage.events) {
    const date = event.createdAt.slice(0, 10);
    const day = days.get(date) ?? { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, unpricedEvents: 0 };
    const provider = byProvider.get(event.provider) ?? {
      provider: event.provider,
      totalTokens: 0,
      estimatedCostUsd: 0,
      unpricedEvents: 0,
      models: new Map(),
      days: new Map()
    };
    const model = provider.models.get(event.model) ?? { model: event.model, totalTokens: 0, lastUsedAt: event.createdAt };
    model.totalTokens += event.totalTokens;
    if (event.createdAt > model.lastUsedAt) model.lastUsedAt = event.createdAt;
    provider.models.set(event.model, model);
    const providerDay = provider.days.get(date) ?? { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, unpricedEvents: 0 };
    providerDay.inputTokens += event.inputTokens;
    providerDay.outputTokens += event.outputTokens;
    providerDay.totalTokens += event.totalTokens;
    provider.days.set(date, providerDay);
    const cost = event.costSource === "provider" && typeof event.costUsd === "number" && Number.isFinite(event.costUsd) && event.costUsd >= 0
      ? event.costUsd : estimateTokenCostUsd(event.provider, event.model, event, pricing);
    day.inputTokens += event.inputTokens;
    day.outputTokens += event.outputTokens;
    day.totalTokens += event.totalTokens;
    provider.totalTokens += event.totalTokens;
    totalTokens += event.totalTokens;
    if (cost === undefined) {
      day.unpricedEvents += 1;
      providerDay.unpricedEvents += 1;
      provider.unpricedEvents += 1;
      unpricedEvents += 1;
    } else {
      day.estimatedCostUsd += cost;
      providerDay.estimatedCostUsd += cost;
      provider.estimatedCostUsd += cost;
      estimatedCostUsd += cost;
    }
    days.set(date, day);
    byProvider.set(event.provider, provider);
  }
  const safeLogs = projectHistoryLogs(logs);
  return {
    generatedAt: new Date().toISOString(),
    configRoot: getConfigRoot(),
    providers,
    usage: {
      totalTokens, estimatedCostUsd, unpricedEvents,
      daily: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)),
      providers: [...byProvider.values()].sort((left, right) => right.totalTokens - left.totalTokens)
        .map(({ days: providerDays, models, ...provider }) => ({
          ...provider,
          models: [...models.values()].sort((left, right) => right.totalTokens - left.totalTokens || right.lastUsedAt.localeCompare(left.lastUsedAt) || left.model.localeCompare(right.model)),
          daily: [...providerDays.values()].sort((left, right) => left.date.localeCompare(right.date))
        }))
    },
    pricing,
    calls: summarizeCalls(safeLogs, new Set(sessions.map(session => session.id))),
    logs: safeLogs.reverse(),
    sessions: sessions.map(({ id, tool, provider, model, startedAt, endedAt, status, exitCode, fallbackFrom, actualProvider, actualModel, nativeSessionId, traceId, resumedFrom }) =>
      ({ id, tool, provider, model, startedAt, endedAt, status, exitCode, fallbackFrom, actualProvider, actualModel, nativeSessionId, traceId, resumedFrom })),
    codex: { ...codex, runtimeProviderName: providers.find(provider => providerIdForName(provider.name) === codex.providerId)?.name ?? null }, codexUsage, settings
  };
}

async function readCodexConfigSummary() {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const [raw, authConfigured, rawAuth] = await Promise.all([
    fs.readFile(configPath, "utf8").catch(() => ""),
    fs.stat(authPath).then((stat) => stat.isFile()).catch(() => false),
    fs.readFile(authPath, "utf8").catch(() => "")
  ]);
  let accountEmail: string | null = null;
  let authMode: string | null = null;
  try {
    const auth = JSON.parse(rawAuth);
    if (auth && typeof auth === "object" && typeof auth.auth_mode === "string") authMode = auth.auth_mode;
    if (authMode === "chatgpt" && typeof auth.tokens?.id_token === "string") {
      const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1] ?? "", "base64url").toString("utf8"));
      if (typeof claims.email === "string" && claims.email.length <= 200 && !/[\r\n\0]/.test(claims.email)) accountEmail = claims.email;
    }
  } catch { /* Missing or unreadable local account details. */ }
  let config: Record<string, unknown> = {};
  let configError: string | null = null;
  try { config = parse(raw); } catch { configError = "配置文件格式无效，无法读取。"; }
  const field = (name: string) => typeof config[name] === "string" ? config[name] as string : null;
  const providerId = field("model_provider") ?? "openai";
  const tables = config.model_providers;
  const provider = tables && typeof tables === "object" ? (tables as Record<string, unknown>)[providerId] : null;
  const entry = provider && typeof provider === "object" ? provider as Record<string, unknown> : {};
  const providerName = typeof entry.name === "string" ? entry.name : null;
  let baseUrl: string | null = null;
  try { if (typeof entry.base_url === "string") { const u = new URL(entry.base_url); if (!u.username && !u.password && !u.search && !u.hash && ["http:", "https:"].includes(u.protocol)) baseUrl = u.toString(); } } catch { /* invalid address */ }
  const shell = config.shell_environment_policy;
  const set = shell && typeof shell === "object" && "set" in shell ? shell.set : null;
  const proxy = set && typeof set === "object" && "HTTP_PROXY" in set && typeof set.HTTP_PROXY === "string" ? set.HTTP_PROXY : null;
  return { providerId, providerName, baseUrl, accountEmail, authMode, model: field("model"), reasoningEffort: field("model_reasoning_effort"), sandboxMode: field("sandbox_mode"), approvalPolicy: field("approval_policy"), proxy, configError, authConfigured, configPresent: Boolean(raw), configPath, authPath };
}
