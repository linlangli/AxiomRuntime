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

export type OpenAiUsageProxyRoute = {
  provider: Provider;
  model: string;
};

export type OpenAiUsageProxyFailoverEvent = {
  type: "automatic" | "confirmation_required" | "confirmed";
  from: OpenAiUsageProxyRoute;
  to: OpenAiUsageProxyRoute;
  reason: string;
};

export type StartOpenAiUsageProxyInput = {
  provider: Provider;
  model: string;
  tool: RunToolType;
  engine?: CliToolType;
  fallbackRoutes?: OpenAiUsageProxyRoute[];
  onFailover?: (event: OpenAiUsageProxyFailoverEvent) => void | Promise<void>;
  onRouteResult?: (route: OpenAiUsageProxyRoute, success: boolean, reason?: string) => void | Promise<void>;
  onUsage?: (record: OpenAiUsageProxyRecord) => void | Promise<void>;
  upstreamHeadersTimeoutMs?: number;
};
