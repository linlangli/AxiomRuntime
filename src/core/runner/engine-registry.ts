import type { CliToolType, Provider } from "../types.js";
import { resolveClaudePermissionMode } from "./claude-permission-policy.js";

export type RunnerArgsInput = {
  provider: Provider;
  model: string;
  settingsPath?: string | null;
  uid?: number | null;
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
  buildArgs: ({ provider, model, settingsPath, uid }) => {
    const args = ["--model", model];
    if (settingsPath) {
      args.push("--settings", settingsPath);
    }
    const permission = resolveClaudePermissionMode(
      provider.mode === "auto" ? "bypassPermissions" : "default",
      { uid }
    );
    if (permission.effectiveMode === "bypassPermissions") {
      args.push("--permission-mode", "bypassPermissions");
      args.push("--dangerously-skip-permissions");
    }
    return args;
  }
});

registerRunnerEngine({
  name: "codex",
  authInjection: "process env + process-scoped Codex provider override",
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
  buildArgs: ({ provider, model }) => {
    const providerId = "ai_gateway_selected";
    const baseUrl = getRunnerEngine("codex").normalizeBaseUrl(provider.baseUrl);
    const args = [
      "-c",
      `model_provider=${tomlString(providerId)}`,
      "-c",
      `model_providers.${providerId}.name=${tomlString(`AI Gateway (${provider.name})`)}`,
      "-c",
      `model_providers.${providerId}.base_url=${tomlString(baseUrl)}`,
      "-c",
      `model_providers.${providerId}.env_key=${tomlString("OPENAI_API_KEY")}`,
      "-c",
      `model_providers.${providerId}.requires_openai_auth=true`,
      "-c",
      `model_providers.${providerId}.wire_api=${tomlString("responses")}`,
      "--model",
      model
    ];
    if (provider.mode === "auto") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    return args;
  }
});

function tomlString(value: string): string {
  return JSON.stringify(value);
}
