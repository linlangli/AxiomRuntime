import { appendUsageEvent } from "../config/usage-store.js";
import { getLogContext, newTraceId, writeLog } from "../logs/log-service.js";
import { extractTokenUsage } from "../models/model-discovery.js";
import type { RunToolType, TokenUsage } from "../types.js";
import { estimateTokenCostUsdFromConfig } from "../usage/pricing.js";
import { buildUsageEvent } from "../usage/usage-service.js";
import type { OpenAiUsageProxyRecord } from "./openai-usage-types.js";

export async function recordUsageFromResponse(input: {
  text: string;
  contentType: string;
  fallbackModel: string;
  provider: string;
  tool: RunToolType;
  records: OpenAiUsageProxyRecord[];
  onUsage?: (record: OpenAiUsageProxyRecord) => void | Promise<void>;
}): Promise<boolean> {
  const candidate = extractBestUsageCandidate(input.text, input.contentType, input.fallbackModel);
  if (!candidate) {
    await writeLog({
      category: "usage",
      action: "openai_usage_proxy_no_usage",
      message: `Provider response did not include usage for ${input.provider} / ${input.fallbackModel}.`,
      metadata: {
        tool: input.tool,
        provider: input.provider,
        model: input.fallbackModel,
        contentType: input.contentType
      }
    });
    return false;
  }

  const pricedCost = candidate.costUsd ?? await estimateTokenCostUsdFromConfig(input.provider, candidate.model, candidate.usage);
  const record: OpenAiUsageProxyRecord = {
    provider: input.provider,
    model: candidate.model,
    usage: candidate.usage,
    costUsd: pricedCost,
    costSource: candidate.costUsd !== undefined ? "provider" : pricedCost !== undefined ? "pricing" : "unknown"
  };
  input.records.push(record);

  const context = getLogContext();
  await appendUsageEvent(buildUsageEvent({
    id: `usage_${newTraceId()}`,
    ...(context.traceId ? { traceId: context.traceId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    provider: input.provider,
    tool: input.tool,
    model: record.model,
    source: "proxy",
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    totalTokens: record.usage.totalTokens,
    cacheReadInputTokens: record.usage.cacheReadInputTokens,
    ...(record.costUsd !== undefined ? { costUsd: record.costUsd, costSource: record.costSource } : {})
  })).catch(async () => {
    await writeLog({ level: "error", category: "usage", action: "usage_persistence_failed", message: "Provider usage was observed but could not be persisted.", metadata: { provider: input.provider, model: record.model } });
  });
  await writeLog({
    category: "usage",
    action: "openai_usage_proxy_recorded",
    message: `Recorded proxied usage for ${record.provider} / ${record.model}.`,
    metadata: {
      tool: input.tool,
      provider: record.provider,
      model: record.model,
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      totalTokens: record.usage.totalTokens,
      cacheReadInputTokens: record.usage.cacheReadInputTokens,
      costUsd: record.costUsd,
      costSource: record.costSource
    }
  });
  await Promise.resolve(input.onUsage?.(record)).catch(() => undefined);
  return true;
}

type UsageCandidate = {
  model: string;
  usage: TokenUsage;
  costUsd?: number;
};

function extractBestUsageCandidate(text: string, contentType: string, fallbackModel: string): UsageCandidate | null {
  const values = contentType.includes("text/event-stream") ? parseSseValues(text) : parseJsonValues(text);
  const candidates: UsageCandidate[] = [];

  for (const value of values) {
    candidates.push(...collectUsageCandidates(value, fallbackModel));
  }

  return mergeUsageCandidates(candidates, fallbackModel);
}

function mergeUsageCandidates(candidates: UsageCandidate[], fallbackModel: string): UsageCandidate | null {
  if (!candidates.length) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheReadInputTokens: number | undefined;
  let model = fallbackModel;
  let modelCandidateTokens = -1;
  let costUsd: number | undefined;

  for (const candidate of candidates) {
    inputTokens = Math.max(inputTokens, candidate.usage.inputTokens);
    outputTokens = Math.max(outputTokens, candidate.usage.outputTokens);
    totalTokens = Math.max(totalTokens, candidate.usage.totalTokens);
    if (candidate.usage.cacheReadInputTokens !== undefined) {
      cacheReadInputTokens = Math.max(cacheReadInputTokens ?? 0, candidate.usage.cacheReadInputTokens);
    }
    if (candidate.usage.totalTokens >= modelCandidateTokens) {
      model = candidate.model;
      modelCandidateTokens = candidate.usage.totalTokens;
    }
    if (candidate.costUsd !== undefined) {
      costUsd = Math.max(costUsd ?? 0, candidate.costUsd);
    }
  }

  return {
    model,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: Math.max(totalTokens, inputTokens + outputTokens),
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {})
    },
    ...(costUsd !== undefined ? { costUsd } : {})
  };
}

function parseJsonValues(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return [];
  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    return [];
  }
}

function parseSseValues(text: string): unknown[] {
  const values: unknown[] = [];
  let data = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      pushSseData(values, data);
      data = "";
      continue;
    }
    if (line.startsWith("data:")) {
      data += `${line.slice(5).trimStart()}\n`;
    }
  }
  pushSseData(values, data);
  return values;
}

function pushSseData(values: unknown[], data: string): void {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return;
  try {
    values.push(JSON.parse(trimmed) as unknown);
  } catch {
    // Ignore non-JSON SSE frames.
  }
}

function collectUsageCandidates(value: unknown, fallbackModel: string, depth = 0): UsageCandidate[] {
  if (depth > 6 || !value || typeof value !== "object") return [];

  const candidates: UsageCandidate[] = [];
  const usage = extractTokenUsage(value);
  if (usage) {
    candidates.push({
      model: extractModel(value) ?? fallbackModel,
      usage,
      costUsd: extractCostUsd(value)
    });
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      candidates.push(...collectUsageCandidates(item, fallbackModel, depth + 1));
    }
    return candidates;
  }

  const record = value as Record<string, unknown>;
  for (const nested of Object.values(record)) {
    candidates.push(...collectUsageCandidates(nested, extractModel(record) ?? fallbackModel, depth + 1));
  }
  return candidates;
}

export function extractRequestModel(body: Buffer): string | undefined {
  const text = body.toString("utf8").trim();
  if (!text || !text.startsWith("{")) return undefined;
  try {
    return extractModel(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function extractModel(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const model = (value as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

function extractCostUsd(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["total_cost_usd", "cost_usd", "costUsd", "totalCostUsd", "total_cost", "cost"]) {
    const cost = readCostValue(record[key]);
    if (cost !== undefined) return cost;
  }
  return undefined;
}

function readCostValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().replace(/^\$/, "");
    const numeric = Number(normalized);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return undefined;
}
