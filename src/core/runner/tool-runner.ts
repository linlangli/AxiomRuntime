import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordProviderRuntimeFailure, recordProviderRuntimeSuccess, saveLastSelection } from "../config/cache-store.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { newTraceId, writeLog } from "../logs/log-service.js";
import { applyProxyToEnv, resolveProviderProxy } from "../network/proxy.js";
import type { CliToolType, Provider, SessionRecord } from "../types.js";
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
import { finishSession, getSession, recordSessionProvider, startSession } from "../sessions/session-service.js";
import { updateSession } from "../config/session-store.js";
import { findNativeCodexSession } from "../sessions/native-session.js";

export type RunToolOptions = {
  fallbackFrom?: string | null; fallbackRoutes?: OpenAiUsageProxyRoute[]; traceId?: string;
  cwd?: string; nativeSessionId?: string; resumedFrom?: string;
  onSettled?: (session: SessionRecord) => void;
};

export async function runTool(
  tool: CliToolType,
  provider: Provider,
  model: string,
  options: RunToolOptions = {}
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
  const requestedCwd = path.resolve(options.cwd ?? process.cwd());
  const cwd = await fs.promises.realpath(requestedCwd).catch(() => requestedCwd);
  const traceId = options.traceId ?? newTraceId();
  const nativeSessionId = options.nativeSessionId ?? (tool === "claude" ? randomUUID() : undefined);
  const session = await startSession({
    tool, provider: effectiveProvider, model, projectPath: cwd, traceId, nativeSessionId,
    fallbackFrom: options.fallbackFrom, resumedFrom: options.resumedFrom
  });
  const usageProxy = await startOpenAiUsageProxy({
    provider: effectiveProvider,
    model,
    tool,
    engine: tool,
    traceId,
    sessionId: session.id,
    fallbackRoutes: options.fallbackRoutes,
    onRouteResult: async (route, success, reason) => {
      if (success) await recordProviderRuntimeSuccess(route.provider.name);
      else await recordProviderRuntimeFailure(route.provider.name, reason ?? "request_failed");
    },
    onRequestSettled: async (request) => {
      if (request.success && request.provider && request.model) {
        await recordSessionProvider(session.id, { traceId: request.traceId, provider: request.provider, model: request.model });
        await saveLastSelection(tool, request.provider, request.model);
      }
    },
    // 子进程独占终端期间不直接写 stdio：提示由代理写回协议内，这里只累积，退出后统一汇总。
    onFailover: (event) => {
      failoverEvents.push(event);
    }
  }).catch(async (error) => {
    await finishSession(session.id, 1);
    throw error;
  });
  const temporaryFiles: string[] = [];
  const setup = await (async () => {
    try {
      const routedProvider = { ...effectiveProvider, baseUrl: usageProxy.baseUrl };
      const runtimeConfig = await loadRuntimeConfig();
      // 子 env 用所选 Provider 的代理（Provider 级优先、全局默认兜底）。模型流量本身走本地
      // Transport Proxy，其上游按路由各自分派代理；这里的 env 只影响子 CLI 自身的其他出站。
      const env = applyProxyToEnv(
        buildRunnerEnv(tool, routedProvider, model),
        resolveProviderProxy(effectiveProvider, runtimeConfig.proxyUrl)
      );
      const claudeSettingsPath = engine.requiresSettingsFile
        ? writeTemporaryClaudeSettings(routedProvider, { permissionMode: launchPolicy.claudeSettingsPermissionMode })
        : null;
      if (claudeSettingsPath) temporaryFiles.push(claudeSettingsPath);
      const args = buildRunnerArgs(tool, routedProvider, model, claudeSettingsPath);
      if (tool === "claude") args.push(options.nativeSessionId ? "--resume" : "--session-id", nativeSessionId!);
      else if (options.nativeSessionId) args.unshift("resume", options.nativeSessionId);
      const effectiveBaseUrl = getToolBaseUrl(tool, effectiveProvider);
      await writeLog({
        category: "usage",
        action: "tool_spawn",
        message: `Spawning ${tool}: ${provider.name} / ${model}`,
        traceId,
        metadata: {
          sessionId: session.id,
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
      return { args, env };
    } catch (error) {
      cleanupTemporaryFiles(temporaryFiles);
      await usageProxy.close().catch(() => undefined);
      await finishSession(session.id, 1);
      throw error;
    }
  })();
  const { args, env } = setup;

  return new Promise((resolve, reject) => {
    let finished = false;
    let child: ChildProcess | undefined;
    const signals = ["SIGINT", "SIGTERM"] as const;
    const forwardSignal = (signal: NodeJS.Signals) => { child?.kill(signal); };
    const signalHandlers = signals.map(signal => ({ signal, handler: () => forwardSignal(signal) }));
    const finish = async (exitCode: number, error?: Error): Promise<void> => {
      if (finished) return;
      finished = true;
      for (const { signal, handler } of signalHandlers) process.off(signal, handler);
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
      try {
        if (tool === "codex" && !nativeSessionId) {
          const detected = await findNativeCodexSession({ cwd, startedAt: Date.parse(session.startedAt), finishedAt: Date.now() });
          if (detected) await updateSession(session.id, { nativeSessionId: detected });
        }
        const completed = await getSession(session.id);
        if (completed) options.onSettled?.(completed);
      } catch {
        await writeLog({ level: "warn", category: "system", action: "session_projection_failed", message: "Tool exited but its final session projection could not be updated.", traceId, metadata: { sessionId: session.id } });
      }
      // 子进程已退出，终端所有权回到父进程：此时打印汇总不会破坏 TUI 渲染。
      const summary = formatFailoverSummary(failoverEvents);
      if (summary) console.error(summary);
      if (error) {
        reject(error);
      } else {
        resolve(exitCode);
      }
    };

    try {
      child = spawn(command, args, {
        stdio: "inherit",
        env,
        cwd
      });
      for (const { signal, handler } of signalHandlers) process.on(signal, handler);
    } catch (error) {
      void finish(1, new Error(`Failed to start ${command}. Run \`ai doctor\` to check local CLI installation. ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    child.on("error", (error) => {
      void finish(1, new Error(`Failed to start ${command}. Run \`ai doctor\` to check local CLI installation. ${error.message}`));
    });

    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1);
      void finish(exitCode);
    });
  });
}

export function getSecretFingerprint(value: string): string {
  if (!value) return "(empty)";
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
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
