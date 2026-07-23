import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveLastSelection } from "../config/cache-store.js";
import { writeLog } from "../logs/log-service.js";
import type { CliToolType, Provider } from "../types.js";
import { isRecord } from "../utils/is-record.js";
import { resolveToolCommand } from "./command-resolver.js";
import { getRunnerEngine } from "./engine-registry.js";
import { finishSession, startSession } from "../sessions/session-service.js";

export async function runTool(tool: CliToolType, provider: Provider, model: string, options: { fallbackFrom?: string | null } = {}): Promise<number> {
  await saveLastSelection(tool, provider.name, model);
  const command = resolveToolCommand(tool);
  if (!command) {
    throw new Error(`Failed to find ${tool} CLI. Run \`ai doctor\` to check local CLI installation.`);
  }
  const engine = getRunnerEngine(tool);
  const env = buildRunnerEnv(tool, provider, model);
  const temporaryFiles: string[] = [];
  const claudeSettingsPath = engine.requiresSettingsFile ? writeTemporaryClaudeSettings(provider) : null;
  if (claudeSettingsPath) temporaryFiles.push(claudeSettingsPath);
  const args = buildRunnerArgs(tool, provider, model, claudeSettingsPath);
  const effectiveBaseUrl = getToolBaseUrl(tool, provider);
  await writeLog({
    category: "usage",
    action: "tool_spawn",
    message: `Spawning ${tool}: ${provider.name} / ${model}`,
    metadata: {
      tool,
      provider: provider.name,
      model,
      mode: provider.mode,
      baseUrl: effectiveBaseUrl,
      configuredBaseUrl: provider.baseUrl,
      apiKeyFingerprint: getSecretFingerprint(provider.apiKey),
      command,
      args,
      authInjection: engine.authInjection
    }
  });
  const session = await startSession({
    tool,
    provider,
    model,
    projectPath: process.cwd(),
    fallbackFrom: options.fallbackFrom ?? null
  });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env
    });

    child.on("error", (error) => {
      cleanupTemporaryFiles(temporaryFiles);
      void finishSession(session.id, 1);
      reject(new Error(`Failed to start ${command}. Run \`ai doctor\` to check local CLI installation. ${error.message}`));
    });

    child.on("close", (code) => {
      cleanupTemporaryFiles(temporaryFiles);
      const exitCode = code ?? 0;
      void finishSession(session.id, exitCode).finally(() => resolve(exitCode));
    });
  });
}

export function getSecretFingerprint(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 12) return `len=${value.length}`;
  return `${value.slice(0, 8)}...${value.slice(-6)} len=${value.length}`;
}

export function buildRunnerArgs(tool: CliToolType, provider: Provider, model: string, claudeSettingsPath: string | null): string[] {
  return getRunnerEngine(tool).buildArgs({ provider, model, settingsPath: claudeSettingsPath });
}

const AUTO_PERMISSIONS = {
  defaultMode: "bypassPermissions",
  allow: [
    "Bash",
    "Edit",
    "Write",
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "MultiEdit",
    "NotebookEdit"
  ],
  deny: []
};

const READ_ONLY_PERMISSIONS = {
  defaultMode: "default",
  allow: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
  deny: ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]
};

export function writeTemporaryClaudeSettings(
  provider: Provider,
  options: { permissionMode?: "provider" | "readOnly" } = {}
): string {
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const settings = readClaudeSettings(userSettingsPath);
  const settingsEnv = isRecord(settings.env) ? settings.env : {};
  const baseUrl = getToolBaseUrl("claude", provider);
  settings.env = {
    ...settingsEnv,
    ANTHROPIC_API_KEY: provider.apiKey,
    ANTHROPIC_BASE_URL: baseUrl
  };

  if (options.permissionMode === "readOnly") {
    settings.permissions = { ...READ_ONLY_PERMISSIONS };
  } else if (provider.mode === "auto") {
    settings.permissions = { ...AUTO_PERMISSIONS };
  }

  const settingsPath = path.join(os.tmpdir(), `ai-gateway-claude-settings-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settingsPath;
}

function readClaudeSettings(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

export function cleanupTemporaryFiles(filePaths: string[]): void {
  for (const filePath of filePaths) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup for temporary launch settings.
    }
  }
}

export function buildRunnerEnv(tool: CliToolType, provider: Provider, model: string): NodeJS.ProcessEnv {
  return getRunnerEngine(tool).buildEnv(provider, model, process.env);
}

export function getToolBaseUrl(tool: CliToolType, provider: Provider): string {
  return getRunnerEngine(tool).normalizeBaseUrl(provider.baseUrl);
}
