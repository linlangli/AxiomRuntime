import fs from "node:fs/promises";
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

export async function getWebDashboard() {
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
    const cost = estimateTokenCostUsd(event.provider, event.model, event, pricing);
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
    sessions: sessions.map(({ id, tool, provider, model, startedAt, endedAt, status, exitCode, fallbackFrom }) =>
      ({ id, tool, provider, model, startedAt, endedAt, status, exitCode, fallbackFrom })),
    codex, settings
  };
}

async function readCodexConfigSummary() {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const [config, authConfigured] = await Promise.all([
    fs.readFile(configPath, "utf8").catch(() => ""),
    fs.stat(authPath).then((stat) => stat.isFile()).catch(() => false)
  ]);
  const topLevel = config.split(/^\s*\[/m, 1)[0] ?? "";
  const field = (name: string): string | null => {
    const match = topLevel.match(new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']*)["']`, "m"));
    return match?.[1] ?? null;
  };
  const proxy = config.match(/^\s*(?:HTTP_PROXY|http_proxy)\s*=\s*["']([^"']*)["']/m)?.[1] ?? null;
  return { providerId: field("model_provider") ?? "openai", model: field("model"), proxy, authConfigured, configPresent: Boolean(config), configPath, authPath };
}
