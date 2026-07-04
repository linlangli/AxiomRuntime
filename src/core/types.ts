export type ToolType = "claude" | "codex";

export type ProviderMode = "ask" | "auto";

export type HealthStatus = "ok" | "error" | "unknown";

export type Provider = {
  name: string;
  baseUrl: string;
  apiKey: string;
  mode: ProviderMode;
  level: number;
  model: string;
};

export type ProviderCache = {
  status: HealthStatus;
  models: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
};

export type CacheFile = {
  providers: Record<string, ProviderCache>;
  lastSelection?: {
    tool: ToolType;
    provider: string;
    model: string;
    usedAt: string;
  };
};

export type UsageEvent = {
  provider: string;
  tool: ToolType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  createdAt: string;
};

export type UsageFile = {
  events: UsageEvent[];
};

export type ProviderStatus = Provider & {
  health: HealthStatus;
  models: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
  weeklyTokens: number;
  usageShare: number;
};

export type ConnectivityResult = {
  status: HealthStatus;
  models: string[];
  error: string | null;
  checkedAt: string;
};
