export type CliToolType = "claude" | "codex";

export type RunToolType = CliToolType | "provider" | "telegram" | "image";

export type ProviderMode = "ask" | "auto";

export type ProviderAuthScheme = "bearer" | "x-api-key" | "api-key";

export type ProviderRequestProfile = {
  discoveryAuth: ProviderAuthScheme;
  openaiAuth: ProviderAuthScheme;
  anthropicAuth: ProviderAuthScheme;
  verifiedProtocols: Array<"openai" | "anthropic">;
};

export type HealthStatus = "ok" | "error" | "unknown";

export type Provider = {
  name: string;
  baseUrl: string;
  apiKey: string;
  mode: ProviderMode;
  level: number;
  model: string;
  /** 出站代理 origin；未设置时回退 runtime.json 的全局默认。 */
  proxyUrl?: string;
  requestProfile?: ProviderRequestProfile;
};

export type ProviderCache = {
  status: HealthStatus;
  models: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
  consecutiveFailures?: number;
  lastFailureAt?: string | null;
  circuitOpenUntil?: string | null;
  healthScore?: number;
  toolChecks?: Partial<Record<CliToolType, ProviderToolCheck>>;
};

export type ProviderToolCheck = {
  status: "ok" | "error" | "unknown" | "not_applicable";
  model: string | null;
  checkedAt: string;
  error: string | null;
  attempts: number;
  durationMs: number;
};

export type CacheFile = {
  providers: Record<string, ProviderCache>;
  lastSelection?: {
    tool: CliToolType;
    provider: string;
    model: string;
    usedAt: string;
  };
};

export type UsageEvent = {
  provider: string;
  tool: RunToolType;
  model: string;
  source: "doctor_deep" | "model_probe" | "proxy" | "cli" | "codex_app";
  id?: string;
  traceId?: string;
  sessionId?: string;
  costUsd?: number;
  costSource?: "provider" | "pricing" | "unknown";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  createdAt: string;
};

export type UsageFile = {
  events: UsageEvent[];
};

export type MemoryEmbeddingProviderType = "openai-compatible" | "jina";

export type MemoryEmbeddingConfig = {
  enabled: boolean;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerType: MemoryEmbeddingProviderType;
  queryTask?: string;
  passageTask?: string;
  dimensions: number | null;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
};

export type MemoryConfigFile = {
  embedding: MemoryEmbeddingConfig | null;
};

export type SessionStatus = "running" | "completed" | "failed";

export type SessionRecord = {
  id: string;
  tool: RunToolType;
  provider: string;
  model: string;
  mode: ProviderMode;
  projectPath: string;
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  exitCode: number | null;
  fallbackFrom: string | null;
  traceId?: string;
  actualProvider?: string;
  actualModel?: string;
  lastRequestId?: string;
  nativeSessionId?: string;
  resumedFrom?: string;
};

export type SessionsFile = {
  sessions: SessionRecord[];
};

export type ProviderStatus = Provider & {
  health: HealthStatus;
  models: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
  weeklyTokens: number;
  usageShare: number;
  claude: ToolProviderStatus;
  codex: ToolProviderStatus;
};

export type ToolProviderStatus = {
  state: "ready" | "no-model" | "provider-error" | "unknown" | "unverified";
  baseUrl: string;
  model: string | null;
  note: string;
  checkedAt: string | null;
  attempts: number;
  durationMs: number;
};

export type ConnectivityResult = {
  status: HealthStatus;
  models: string[];
  error: string | null;
  checkedAt: string;
  usage?: TokenUsage;
  attempts?: number;
  durationMs?: number;
  retryErrors?: string[];
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
};

export type LogLevel = "info" | "warn" | "error";

export type LogCategory = "usage" | "error" | "strategy" | "provider" | "system" | "telegram";

export type LogEvent = {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  action: string;
  message: string;
  /**
   * 同一次请求/任务内所有日志共享的关联 id，供调用链路视图按链路聚合多跳事件。
   * 历史日志没有该字段，读取方必须容忍缺失。
   */
  traceId?: string;
  metadata?: Record<string, unknown>;
};
