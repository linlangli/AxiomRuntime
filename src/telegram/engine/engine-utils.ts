import { randomUUID } from "node:crypto";
import type { CliToolType, Provider } from "../../core/types.js";
import { resolveProviderForTool } from "../../core/runner/fallback.js";
import { buildRunnerEnv, cleanupTemporaryFiles, getToolBaseUrl, writeTemporaryClaudeSettings } from "../../core/runner/tool-runner.js";
import { resolveToolCommand } from "../../core/runner/command-resolver.js";
import type { PermissionRequest } from "./types.js";

export type RuntimeSelection = {
  provider: Provider;
  model: string;
  env: NodeJS.ProcessEnv;
  command: string;
  temporaryFiles: string[];
  claudeSettingsPath: string | null;
};

export async function prepareEngineRuntime(tool: CliToolType, providerName?: string, modelName?: string): Promise<RuntimeSelection> {
  const { provider, model } = await resolveProviderForTool(tool, providerName, modelName);
  const command = resolveWorkingCommand(tool);
  if (!command) {
    throw new Error(`Failed to find ${tool} CLI. Run \`ai doctor\` to check local CLI installation.`);
  }

  const env = {
    ...buildRunnerEnv(tool, provider, model),
    AI_GATEWAY_SOURCE: "telegram"
  };
  const temporaryFiles: string[] = [];
  const claudeSettingsPath = tool === "claude" ? writeTemporaryClaudeSettings(provider) : null;
  if (claudeSettingsPath) temporaryFiles.push(claudeSettingsPath);
  return { provider, model, env, command, temporaryFiles, claudeSettingsPath };
}

export function cleanupRuntime(runtime: RuntimeSelection): void {
  cleanupTemporaryFiles(runtime.temporaryFiles);
}

export function resolveWorkingCommand(tool: CliToolType): string | null {
  return resolveToolCommand(tool);
}

export function createCommandPermissionRequest(tool: string, command: string): PermissionRequest {
  return {
    id: randomUUID(),
    tool,
    description: `Confirm command before running in Telegram ${tool}.`,
    command,
    params: { command }
  };
}

export function summarizeRuntime(provider: Provider, model: string, tool: CliToolType): Record<string, unknown> {
  return {
    provider: provider.name,
    model,
    baseUrl: getToolBaseUrl(tool, provider)
  };
}

export function formatEngineTimeout(engineLabel: string, timeoutMs: number | undefined, providerName?: string, model?: string): string {
  return [
    `${engineLabel} 请求超时，已自动停止。`,
    timeoutMs ? `超时时间：${formatDuration(timeoutMs)}` : "",
    providerName && model ? `Provider：${providerName} / ${model}` : "",
    "这通常是 CLI 子进程、provider 上游或网络连接卡住导致的。"
  ].filter(Boolean).join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
}
