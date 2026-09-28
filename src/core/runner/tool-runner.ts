import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordProviderRuntimeFailure, recordProviderRuntimeSuccess, saveLastSelection } from "../config/cache-store.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { writeLog } from "../logs/log-service.js";
import { applyProxyToEnv } from "../network/proxy.js";
import type { CliToolType, Provider } from "../types.js";
import { isRecord } from "../utils/is-record.js";
import { resolveToolCommand } from "./command-resolver.js";
import { getRunnerEngine } from "./engine-registry.js";
import { formatFailoverSummary } from "./failover-notice.js";
import { startOpenAiUsageProxy } from "./openai-usage-proxy.js";
import type { OpenAiUsageProxyFailoverEvent, OpenAiUsageProxyRoute } from "./openai-usage-types.js";
import {
  CLAUDE_ROOT_PERMISSION_WARNING,
  resolveClaudePermissionMode,
  type ProcessIdentityOptions
} from "./claude-permission-policy.js";
import { finishSession, startSession } from "../sessions/session-service.js";

export async function runTool(
  tool: CliToolType,
  provider: Provider,
  model: string,
  options: { fallbackFrom?: string | null; fallbackRoutes?: OpenAiUsageProxyRoute[] } = {}
): Promise<number> {
  await saveLastSelection(tool, provider.name, model);
  const command = resolveToolCommand(tool);
  if (!command) {
    throw new Error(`Failed to find ${tool} CLI. Run \`ai doctor\` to check local CLI installation.`);
  }
  const engine = getRunnerEngine(tool);
  const failoverEvents: OpenAiUsageProxyFailoverEvent[] = [];
  const launchPolicy = resolveRunnerLaunchPolicy(tool, provider);
  if (launchPolicy.warning) {
    console.warn(`Warning: ${launchPolicy.warning}`);
  }
  const effectiveProvider = launchPolicy.provider;
  const usageProxy = await startOpenAiUsageProxy({
    provider: effectiveProvider,
    model,
    tool,
    engine: tool,
    fallbackRoutes: options.fallbackRoutes,
    onRouteResult: async (route, success, reason) => {
      if (success) await recordProviderRuntimeSuccess(route.provider.name);
      else await recordProviderRuntimeFailure(route.provider.name, reason ?? "request_failed");
    },
    // 子进程独占终端期间不直接写 stdio：提示由代理写回协议内，这里只累积，退出后统一汇总。
    onFailover: (event) => {
      failoverEvents.push(event);
    }
  });
  const temporaryFiles: string[] = [];
  const setup = await (async () => {
    try {
      const routedProvider = { ...effectiveProvider, baseUrl: usageProxy.baseUrl };
      const runtimeConfig = await loadRuntimeConfig();
      const env = applyProxyToEnv(
        buildRunnerEnv(tool, routedProvider, model),
        runtimeConfig.proxyUrl ?? null
      );
      const claudeSettingsPath = engine.requiresSettingsFile
        ? writeTemporaryClaudeSettings(routedProvider, { permissionMode: launchPolicy.claudeSettingsPermissionMode })
        : null;
      if (claudeSettingsPath) temporaryFiles.push(claudeSettingsPath);
      const args = buildRunnerArgs(tool, routedProvider, model, claudeSettingsPath);
      const effectiveBaseUrl = getToolBaseUrl(tool, effectiveProvider);
      await writeLog({
        category: "usage",
        action: "tool_spawn",
        message: `Spawning ${tool}: ${provider.name} / ${model}`,
        metadata: {
          tool,
          provider: provider.name,
          model,
          mode: effectiveProvider.mode,
          configuredMode: provider.mode,
          permissionConstraint: launchPolicy.reason,
          baseUrl: effectiveBaseUrl,
          transportBaseUrl: usageProxy.baseUrl,
          configuredBaseUrl: provider.baseUrl,
          apiKeyFingerprint: getSecretFingerprint(provider.apiKey),
          command,
          args,
          authInjection: engine.authInjection
        }
      });
      const session = await startSession({
        tool,
        provider: effectiveProvider,
        model,
        projectPath: process.cwd(),
        fallbackFrom: options.fallbackFrom ?? null
      });
      return { args, env, session };
    } catch (error) {
      cleanupTemporaryFiles(temporaryFiles);
      await usageProxy.close().catch(() => undefined);
      throw error;
    }
  })();
  const { args, env, session } = setup;

  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = async (exitCode: number, error?: Error): Promise<void> => {
      if (finished) return;
      finished = true;
      cleanupTemporaryFiles(temporaryFiles);
      await usageProxy.close().catch(async (closeError) => {
        await writeLog({
          level: "warn",
          category: "usage",
          action: "usage_proxy_close_failed",
          message: `Failed to close usage proxy for ${tool}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
          metadata: { tool, provider: provider.name, model }
        }).catch(() => undefined);
      });
      await finishSession(session.id, exitCode).catch(() => undefined);
      // 子进程已退出，终端所有权回到父进程：此时打印汇总不会破坏 TUI 渲染。
      const summary = formatFailoverSummary(failoverEvents);
      if (summary) console.error(summary);
      if (error) {
        reject(error);
      } else {
        resolve(exitCode);
      }
    };

    let child;
    try {
      child = spawn(command, args, {
        stdio: "inherit",
        env
      });
    } catch (error) {
      void finish(1, new Error(`Failed to start ${command}. Run \`ai doctor\` to check local CLI installation. ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    child.on("error", (error) => {
      void finish(1, new Error(`Failed to start ${command}. Run \`ai doctor\` to check local CLI installation. ${error.message}`));
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      void finish(exitCode);
    });
  });
}

export function getSecretFingerprint(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 12) return `len=${value.length}`;
  return `${value.slice(0, 8)}...${value.slice(-6)} len=${value.length}`;
}

export function buildRunnerArgs(
  tool: CliToolType,
  provider: Provider,
  model: string,
  claudeSettingsPath: string | null,
  identity: ProcessIdentityOptions = {}
): string[] {
  const launchPolicy = resolveRunnerLaunchPolicy(tool, provider, identity);
  return getRunnerEngine(tool).buildArgs({
    provider: launchPolicy.provider,
    model,
    settingsPath: claudeSettingsPath,
    uid: identity.uid
  });
}

export type RunnerLaunchPolicy = {
  provider: Provider;
  claudeSettingsPermissionMode: "provider" | "safeDefault";
  warning: string | null;
  reason: "root_bypass_permissions_unsupported" | null;
};

export function resolveRunnerLaunchPolicy(
  tool: CliToolType,
  provider: Provider,
  identity: ProcessIdentityOptions = {}
): RunnerLaunchPolicy {
  if (tool !== "claude") {
    return { provider, claudeSettingsPermissionMode: "provider", warning: null, reason: null };
  }
  const requestedMode = provider.mode === "auto" ? "bypassPermissions" : "default";
  const resolution = resolveClaudePermissionMode(requestedMode, identity);
  return {
    provider: resolution.constrained ? { ...provider, mode: "ask" } : provider,
    claudeSettingsPermissionMode: resolution.privileged ? "safeDefault" : "provider",
    warning: resolution.constrained ? CLAUDE_ROOT_PERMISSION_WARNING : null,
    reason: resolution.reason
  };
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

const SAFE_DEFAULT_PERMISSIONS = {
  defaultMode: "default",
  allow: [],
  deny: []
};

export function writeTemporaryClaudeSettings(
  provider: Provider,
  options: { permissionMode?: "provider" | "readOnly" | "safeDefault" } = {}
): string {
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const settings = readClaudeSettings(userSettingsPath);
  const settingsEnv = isRecord(settings.env) ? settings.env : {};
  const { ANTHROPIC_AUTH_TOKEN: _inheritedAuthToken, ...sanitizedSettingsEnv } = settingsEnv;
  const baseUrl = getToolBaseUrl("claude", provider);
  settings.env = {
    ...sanitizedSettingsEnv,
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_API_KEY: provider.apiKey,
    ANTHROPIC_BASE_URL: baseUrl
  };

  if (options.permissionMode === "safeDefault") {
    settings.permissions = { ...SAFE_DEFAULT_PERMISSIONS };
  } else if (options.permissionMode === "readOnly") {
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
