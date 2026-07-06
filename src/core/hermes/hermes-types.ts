import type { Provider, ProviderMode, HealthStatus } from "../types.js";

export type HermesTelegramBinding = {
  enabled: boolean;
  chatId: string;
  name: string;
};

export type HermesRobot = {
  name: string;
  provider: string;
  model: string;
  mode: ProviderMode;
  telegram: HermesTelegramBinding;
  tasks: HermesTask[];
  source?: HermesRobotSource;
  createdAt: string;
  updatedAt: string;
};

export type HermesTask = {
  id: string;
  name: string;
  type: "cron";
  schedule: string;
  enabled: boolean;
  state: string;
  provider: string;
  model: string;
};

export type HermesRobotSource = {
  type: "manual" | "hermes-config" | "hermes-cron";
  id?: string;
  schedule?: string;
  enabled?: boolean;
  state?: string;
};

export type HermesRobotsFile = {
  robots: HermesRobot[];
};

export type HermesRobotState = {
  robot: string;
  lastUsedAt: string | null;
  lastSessionId: string | null;
  lastError: string | null;
  clearedAt: string | null;
};

export type HermesStateFile = {
  robots: Record<string, HermesRobotState>;
};

export type AddHermesRobotInput = {
  name: string;
  provider: string;
  model: string;
  mode?: ProviderMode;
  telegram?: Partial<HermesTelegramBinding>;
};

export type UpdateHermesRobotInput = Partial<{
  name: string;
  provider: string;
  model: string;
  mode: ProviderMode;
  telegram: Partial<HermesTelegramBinding>;
}>;

export type HermesRobotStatus = {
  robot: HermesRobot;
  status: "ready" | "warning" | "error";
  hermesCli: "installed" | "missing";
  providerHealth: HealthStatus | "missing";
  providerExists: boolean;
  modelAvailable: boolean | "unknown";
  telegram: "configured" | "disabled" | "missing";
  lastUsedAt: string | null;
  lastError: string | null;
  notes: string[];
};

export type HermesConfiguredProviderSource = "ai-gateway" | "local-hermes";

export type HermesConfiguredProvider = {
  name: string;
  sources: HermesConfiguredProviderSource[];
  baseUrl: string;
  defaultModel: string;
  apiMode: string;
  models: string[];
  apiKeyConfigured: boolean;
  active: boolean;
};

export type HermesConfiguredProvidersResult = {
  configPath: string;
  providers: HermesConfiguredProvider[];
};

export type ImportHermesRobotResult = {
  robot: HermesRobot;
  action: "created" | "overwritten" | "renamed";
};

export type ImportLocalHermesResult = {
  imported: HermesRobot[];
  skipped: HermesRobot[];
  importedProviders: Provider[];
  skippedProviders: Provider[];
  sourceDir: string;
};
