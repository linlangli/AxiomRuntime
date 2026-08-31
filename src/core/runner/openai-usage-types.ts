import type { CliToolType, Provider, RunToolType, TokenUsage } from "../types.js";

export type OpenAiUsageProxyRecord = {
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd?: number;
  costSource: "provider" | "pricing" | "unknown";
};

export type OpenAiUsageProxyMetrics = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  noUsageCount: number;
  usageRecordCount: number;
  totalDurationMs: number;
  averageDurationMs: number;
  upstreamStatusCounts: Record<string, number>;
};

export type OpenAiUsageProxy = {
  baseUrl: string;
  close(): Promise<void>;
  getRecords(): OpenAiUsageProxyRecord[];
  getMetrics(): OpenAiUsageProxyMetrics;
};

export type StartOpenAiUsageProxyInput = {
  provider: Provider;
  model: string;
  tool: RunToolType;
  engine?: CliToolType;
  onUsage?: (record: OpenAiUsageProxyRecord) => void | Promise<void>;
  upstreamHeadersTimeoutMs?: number;
};
