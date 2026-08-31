import type { TokenUsage } from "../types.js";
import type { OpenAiUsageProxyRecord } from "./openai-usage-types.js";

export function sumKnownProxyCosts(records: OpenAiUsageProxyRecord[]): number | undefined {
  const knownCosts = records
    .map((record) => record.costUsd)
    .filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost) && cost >= 0);
  if (!knownCosts.length) return undefined;
  return Number(knownCosts.reduce((sum, cost) => sum + cost, 0).toFixed(8));
}

export function sumProxyUsage(records: OpenAiUsageProxyRecord[]): TokenUsage | undefined {
  if (!records.length) return undefined;
  return records.reduce<TokenUsage>((sum, record) => ({
    inputTokens: sum.inputTokens + record.usage.inputTokens,
    outputTokens: sum.outputTokens + record.usage.outputTokens,
    totalTokens: sum.totalTokens + record.usage.totalTokens,
    cacheReadInputTokens: (sum.cacheReadInputTokens ?? 0) + (record.usage.cacheReadInputTokens ?? 0)
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0 });
}
