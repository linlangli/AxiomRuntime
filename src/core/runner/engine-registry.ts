import type { CliToolType, Provider } from "../types.js";

export type RunnerArgsInput = {
  provider: Provider;
  model: string;
  settingsPath?: string | null;
};

export type RunnerEngineDescriptor = {
  name: CliToolType;
  requiresSettingsFile?: boolean;
  authInjection: string;
  normalizeBaseUrl(baseUrl: string): string;
  buildEnv(provider: Provider, model: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  buildArgs(input: RunnerArgsInput): string[];
};

const runnerEngines = new Map<CliToolType, RunnerEngineDescriptor>();

export function registerRunnerEngine(descriptor: RunnerEngineDescriptor): void {
  runnerEngines.set(descriptor.name, descriptor);
}

export function getRunnerEngine(tool: CliToolType): RunnerEngineDescriptor {
  const descriptor = runnerEngines.get(tool);
  if (!descriptor) {
    throw new Error(`Unknown runner engine: ${tool}`);
  }
  return descriptor;
}

export function listRunnerEngines(): RunnerEngineDescriptor[] {
  return [...runnerEngines.values()];
}

registerRunnerEngine({
  name: "claude",
  requiresSettingsFile: true,
  authInjection: "temporary Claude settings env + process env",
  normalizeBaseUrl: (baseUrl) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, ""),
  buildEnv: (provider, model, baseEnv) => {
    const baseUrl = getRunnerEngine("claude").normalizeBaseUrl(provider.baseUrl);
    return {
      ...baseEnv,
      AI_GATEWAY_PROVIDER: provider.name,
      AI_GATEWAY_MODEL: model,
      AI_GATEWAY_MODE: provider.mode,
      AI_GATEWAY_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: provider.apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: model
    };
  },
  buildArgs: ({ provider, model, settingsPath }) => {
    const args = ["--model", model];
    if (settingsPath) {
      args.push("--settings", settingsPath);
    }
    if (provider.mode === "auto") {
      args.push("--dangerously-skip-permissions");
    }
    return args;
  }
});

registerRunnerEngine({
  name: "codex",
  authInjection: "process env",
  normalizeBaseUrl: (baseUrl) => {
    const normalized = baseUrl.replace(/\/+$/, "");
    return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  },
  buildEnv: (provider, model, baseEnv) => {
    const baseUrl = getRunnerEngine("codex").normalizeBaseUrl(provider.baseUrl);
    return {
      ...baseEnv,
      AI_GATEWAY_PROVIDER: provider.name,
      AI_GATEWAY_MODEL: model,
      AI_GATEWAY_MODE: provider.mode,
      AI_GATEWAY_BASE_URL: baseUrl,
      OPENAI_API_KEY: provider.apiKey,
      OPENAI_BASE_URL: baseUrl,
      OPENAI_MODEL: model,
      CODEX_MODEL: model
    };
  },
  buildArgs: ({ model }) => ["--model", model]
});
