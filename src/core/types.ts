export type CliToolType = "claude" | "codex";

export type RunToolType = CliToolType | "hermes" | "telegram";

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
  source: "doctor_deep" | "model_probe" | "proxy" | "cli";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  createdAt: string;
};

export type UsageFile = {
  events: UsageEvent[];
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
  hermesRobot?: string | null;
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
  state: "ready" | "no-model" | "provider-error";
  baseUrl: string;
  model: string | null;
  note: string;
};

export type ConnectivityResult = {
  status: HealthStatus;
  models: string[];
  error: string | null;
  checkedAt: string;
  usage?: TokenUsage;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type LogLevel = "info" | "warn" | "error";

export type LogCategory = "usage" | "error" | "strategy" | "provider" | "system" | "telegram";

export type LogEvent = {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  action: string;
  message: string;
  metadata?: Record<string, unknown>;
};
