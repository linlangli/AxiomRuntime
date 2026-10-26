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

export type SettledProxyRequest = {
  traceId: string;
  provider: string | null;
  model: string | null;
  success: boolean;
  modelInvocation: boolean;
  durationMs: number;
  status: number | string | null;
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
  traceId?: string;
  sessionId?: string;
  engine?: CliToolType;
  fallbackRoutes?: OpenAiUsageProxyRoute[];
  /** 覆盖 runtime.json 的全局默认代理；缺省时由服务自读 runtime.json（测试注入用）。 */
  globalProxyUrl?: string | null;
  onFailover?: (event: OpenAiUsageProxyFailoverEvent) => void | Promise<void>;
  onRouteResult?: (route: OpenAiUsageProxyRoute, success: boolean, reason?: string) => void | Promise<void>;
  onUsage?: (record: OpenAiUsageProxyRecord) => void | Promise<void>;
  onRequestSettled?: (request: SettledProxyRequest) => void | Promise<void>;
  onBufferedResponse?: (response: {
    status: number;
    statusText: string;
    contentType: string;
    body: Buffer;
  }, route: OpenAiUsageProxyRoute, requestModel: string) => void | Promise<void>;
  upstreamHeadersTimeoutMs?: number;
  /** 同一个 Provider 上的最大尝试次数（含首次）。瞬时失败先原地重试，耗尽后才换 Provider。 */
  maxAttemptsPerRoute?: number;
  /** 原地重试的基础退避毫秒数，按尝试次数指数增长。 */
  retryBackoffMs?: number;
};
