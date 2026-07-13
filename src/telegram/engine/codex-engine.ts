import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Engine, EngineExecuteParams, ExecutionResult, ProgressUpdate, ToolCallResult } from "./types.js";
import type { TokenUsage } from "../../core/types.js";
import { cleanupRuntime, createCommandPermissionRequest, formatEngineTimeout, prepareEngineRuntime, summarizeRuntime } from "./engine-utils.js";
import { extractJsonLines, spawnCapture, stripAnsi, terminateProcessTree } from "./process-utils.js";
import { startOpenAiUsageProxy, type OpenAiUsageProxy, type OpenAiUsageProxyRecord } from "../../core/runner/openai-usage-proxy.js";
import { requiresDangerousConfirmation } from "../interaction/approval.js";
import { writeTelegramLog } from "../log.js";
import { isRecord } from "../../core/utils/is-record.js";

export class CodexEngine implements Engine {
  readonly name = "codex" as const;
  private processes = new Map<number, ChildProcess>();
  private controllers = new Map<number, AbortController>();

  async execute(params: EngineExecuteParams): Promise<ExecutionResult> {
    const runtime = await prepareEngineRuntime("codex", params.providerName, params.modelName);
    const controller = new AbortController();
    this.controllers.set(params.chatId, controller);
    const signal = params.signal ?? controller.signal;
    const startTime = Date.now();
    const permissionMode = params.permissionMode ?? "default";

    if (permissionMode === "bypassPermissions" && requiresDangerousConfirmation(params.prompt)) {
      const approved = await params.onPermission(createCommandPermissionRequest("Codex prompt", params.prompt));
      if (!approved) {
        cleanupRuntime(runtime);
        throw new Error("Dangerous command denied.");
      }
    }

    let usageProxy: OpenAiUsageProxy | null = null;
    await params.onProgress?.({ phase: "thinking", message: "Codex started" });
    await writeTelegramLog({
      action: "codex_start",
      message: `Starting Codex for Telegram chat ${params.chatId}`,
      metadata: { ...summarizeRuntime(runtime.provider, runtime.model, "codex"), cwd: params.cwd }
    });

    try {
      usageProxy = await startOpenAiUsageProxy({
        provider: runtime.provider,
        model: runtime.model,
        tool: "telegram"
      });
      const args = buildCodexArgs(params.prompt, runtime.model, params.cwd, permissionMode, {
        baseUrl: usageProxy.baseUrl
      }, params.resume);
      const result = await spawnCapture({
        command: runtime.command,
        args,
        cwd: params.cwd,
        env: {
          ...runtime.env,
          OPENAI_API_KEY: runtime.provider.apiKey,
          OPENAI_BASE_URL: usageProxy.baseUrl,
          AI_GATEWAY_BASE_URL: usageProxy.baseUrl
        },
        signal,
        timeoutMs: params.timeoutMs,
        onStdout: (chunk) => handleCodexProgress(chunk, params.onProgress)
      }, (child) => this.processes.set(params.chatId, child));

      if (result.timedOut) {
        throw new Error(formatEngineTimeout("Codex", params.timeoutMs, runtime.provider.name, runtime.model));
      }
      if (result.aborted) {
        throw new Error("任务已停止。");
      }
      if (result.code !== 0) {
        throw new Error(formatCodexFailure(
          [result.stderr, result.stdout].filter((value) => value.trim()).join("\n") || `Codex exited with code ${result.code}`,
          runtime.provider.name,
          runtime.model
        ));
      }
      await params.onProgress?.({ phase: "done" });
      const parsed = parseCodexOutput(result.stdout, Date.now() - startTime);
      const sessionId = parsed.sessionId ?? findLatestCodexSessionId({
        cwd: params.cwd,
        startedAtMs: startTime,
        finishedAtMs: Date.now()
      });
      if (sessionId && !parsed.sessionId) {
        await writeTelegramLog({
          action: "codex_session_detected",
          message: `Detected Codex session ${sessionId} from local history.`,
          metadata: { chatId: params.chatId, cwd: params.cwd }
        });
      }
      return {
        ...parsed,
        sessionId,
        cost: sumKnownProxyCosts(usageProxy.getRecords()),
        usage: sumProxyUsage(usageProxy.getRecords()),
        provider: runtime.provider.name,
        model: runtime.model
      };
    } finally {
      this.processes.delete(params.chatId);
      this.controllers.delete(params.chatId);
      await usageProxy?.close().catch(() => undefined);
      cleanupRuntime(runtime);
    }
  }

  abort(chatId: number): void {
    if (!Number.isFinite(chatId)) {
      for (const id of new Set([...this.controllers.keys(), ...this.processes.keys()])) {
        this.abort(id);
      }
      return;
    }
    this.controllers.get(chatId)?.abort();
    const child = this.processes.get(chatId);
    if (child) terminateProcessTree(child, "SIGTERM");
    this.controllers.delete(chatId);
    this.processes.delete(chatId);
  }
}

export type CodexProviderOverride = {
  baseUrl: string;
  providerId?: string;
};

export function buildCodexArgs(
  prompt: string,
  model: string,
  cwd: string,
  permissionMode: string,
  providerOverride?: CodexProviderOverride,
  resume?: string | null
): string[] {
  const args = [
    "exec",
    ...(resume ? ["resume"] : []),
    ...buildCodexProviderOverrideArgs(providerOverride),
    "--json",
    "--skip-git-repo-check",
    "-m",
    model,
    ...(resume ? [] : ["-C", cwd])
  ];

  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (permissionMode === "acceptEdits") {
    args.unshift("-a", "never");
    if (resume) {
      args.unshift("-s", "workspace-write");
    } else {
      args.push("-s", "workspace-write");
    }
  } else {
    args.unshift("-a", "on-request");
    if (resume) {
      args.unshift("-s", "workspace-write");
    } else {
      args.push("-s", "workspace-write");
    }
  }

  if (resume) {
    args.push(resume);
  }
  args.push(prompt);
  return args;
}

function buildCodexProviderOverrideArgs(providerOverride?: CodexProviderOverride): string[] {
  if (!providerOverride) return [];
  const providerId = providerOverride.providerId ?? "ai_gateway_proxy";
  return [
    "-c",
    `model_provider=${tomlString(providerId)}`,
    "-c",
    `model_providers.${providerId}.name=${tomlString("AI Gateway Proxy")}`,
    "-c",
    `model_providers.${providerId}.base_url=${tomlString(providerOverride.baseUrl)}`,
    "-c",
    `model_providers.${providerId}.env_key=${tomlString("OPENAI_API_KEY")}`,
    "-c",
    `model_providers.${providerId}.requires_openai_auth=true`,
    "-c",
    `model_providers.${providerId}.wire_api=${tomlString("responses")}`
  ];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function parseCodexOutput(raw: string, duration: number): ExecutionResult {
  const events = extractJsonLines(raw);
  let response = "";
  let sessionId: string | undefined;
  const toolCalls: ToolCallResult[] = [];
  const filesChanged = new Set<string>();

  for (const event of events) {
    if (!isRecord(event)) continue;
    sessionId = readCodexSessionId(event) ?? sessionId;
    const message = readCodexMessage(event);
    if (message) response = message;
    const toolCall = readCodexToolCall(event);
    if (toolCall) toolCalls.push(toolCall);
    for (const filePath of readChangedFiles(event)) {
      filesChanged.add(filePath);
    }
  }

  if (!response.trim()) {
    response = stripAnsi(raw).trim();
  }

  return {
    sessionId,
    response,
    toolCalls,
    filesChanged: [...filesChanged],
    duration
  };
}

export type FindLatestCodexSessionIdInput = {
  cwd: string;
  startedAtMs: number;
  finishedAtMs?: number;
  codexHome?: string;
};

export function findLatestCodexSessionId(input: FindLatestCodexSessionIdInput): string | undefined {
  const codexHome = input.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sessionsRoot = path.join(codexHome, "sessions");
  const finishedAtMs = input.finishedAtMs ?? Date.now();
  const files = listCandidateCodexSessionFiles(sessionsRoot, input.startedAtMs, finishedAtMs);
  const startedWindow = input.startedAtMs - 10_000;
  const finishedWindow = finishedAtMs + 30_000;

  for (const filePath of files) {
    const stat = safeStat(filePath);
    if (!stat || stat.mtimeMs < startedWindow || stat.mtimeMs > finishedWindow) continue;
    const session = readCodexSessionMeta(filePath);
    if (!session) continue;
    if (path.resolve(session.cwd) !== path.resolve(input.cwd)) continue;
    if (session.source && session.source !== "exec") continue;
    return session.sessionId;
  }

  return undefined;
}

export function formatCodexFailure(raw: string, providerName?: string, model?: string): string {
  const text = stripAnsi(raw).trim();
  if (/stream disconnected/i.test(text)) {
    return [
      "Codex 请求失败：模型流式响应连续断开，已重试 5 次。",
      providerName && model ? `Provider：${providerName} / ${model}` : "",
      "这通常是 provider 上游或网络连接不稳定，不是 Telegram 输入格式问题。"
    ].filter(Boolean).join("\n");
  }

  const meaningful = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isBenignCodexDiagnostic(line))
    .join("\n")
    .trim();
  return meaningful || text || "Codex exited without a diagnostic message.";
}

function isBenignCodexDiagnostic(line: string): boolean {
  return line === "Reading additional input from stdin..."
    || /codex_core_plugins::remote::remote_installed_plugin_sync/.test(line)
    || /codex_features: unknown feature key in config/.test(line)
    || /codex_core_plugins::manifest: ignoring interface\.defaultPrompt/.test(line)
    || /codex_core_plugins::manager: failed to warm featured plugin ids cache/.test(line);
}

function listCandidateCodexSessionFiles(sessionsRoot: string, startedAtMs: number, finishedAtMs: number): string[] {
  const dayDirs = new Set<string>();
  for (const ms of [startedAtMs, finishedAtMs, startedAtMs - 24 * 60 * 60 * 1000, finishedAtMs + 24 * 60 * 60 * 1000]) {
    const date = new Date(ms);
    dayDirs.add(path.join(
      sessionsRoot,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ));
  }

  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of dayDirs) {
    for (const filePath of listJsonlFiles(dir)) {
      const stat = safeStat(filePath);
      if (stat) files.push({ path: filePath, mtimeMs: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).map((file) => file.path);
}

function listJsonlFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

type CodexSessionMeta = {
  sessionId: string;
  cwd: string;
  source?: string;
};

function readCodexSessionMeta(filePath: string): CodexSessionMeta | null {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/).slice(0, 20)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event) || event.type !== "session_meta" || !isRecord(event.payload)) continue;
      const sessionId = readCodexSessionId(event);
      const cwd = typeof event.payload.cwd === "string" ? event.payload.cwd : "";
      if (sessionId && cwd) {
        return {
          sessionId,
          cwd,
          source: typeof event.payload.source === "string" ? event.payload.source : undefined
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function handleCodexProgress(chunk: string, onProgress?: (update: ProgressUpdate) => void | Promise<void>): void {
  if (!onProgress) return;
  for (const event of extractJsonLines(chunk)) {
    if (!isRecord(event)) continue;
    const toolCall = readCodexToolCall(event);
    if (toolCall) {
      void onProgress(readCodexProgressUpdate(event, toolCall.tool));
      continue;
    }
    if (String(event.type ?? "").includes("message")) {
      void onProgress({ phase: "writing" });
    }
  }
}

function readCodexProgressUpdate(event: Record<string, unknown>, fallbackTool: string): ProgressUpdate {
  const type = String(event.type ?? event.kind ?? "");
  const input = isRecord(event.input) ? event.input : {};
  const command = readFirstString(event.command, input.command, event.cmd, input.cmd);
  if (command || /exec|command|shell/i.test(type)) {
    return {
      phase: "tool_calling",
      tool: command ?? fallbackTool,
      toolKind: "command"
    };
  }

  const mcpServer = readFirstString(event.mcpServer, event.mcp_server, event.server, input.mcpServer, input.server);
  const mcpTool = readFirstString(event.tool, event.name, input.tool, input.name);
  if (mcpServer || /mcp/i.test(type)) {
    return {
      phase: "tool_calling",
      tool: mcpTool ?? fallbackTool,
      toolKind: "mcp",
      mcpServer
    };
  }

  return {
    phase: "tool_calling",
    tool: fallbackTool,
    toolKind: "builtin"
  };
}

function readFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readCodexSessionId(event: Record<string, unknown>, depth = 0): string | null {
  if (depth > 4) return null;
  for (const key of ["session_id", "sessionId"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const id = event.id;
  if (typeof id === "string" && isUuidLike(id)) return id;
  for (const key of ["payload", "item", "message", "response"]) {
    const value = event[key];
    if (isRecord(value)) {
      const nested = readCodexSessionId(value, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function readCodexMessage(event: Record<string, unknown>): string | null {
  for (const key of ["last_message", "message", "summary", "output", "text", "content"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (isRecord(event.item)) {
    return readCodexMessage(event.item);
  }
  return null;
}

function readCodexToolCall(event: Record<string, unknown>): ToolCallResult | null {
  const type = String(event.type ?? event.kind ?? "");
  if (!/tool|command|exec|patch/i.test(type)) return null;
  const tool = String(event.tool ?? event.name ?? event.command ?? type);
  return {
    tool,
    input: isRecord(event.input) ? event.input : {},
    output: typeof event.output === "string" ? event.output : "",
    status: String(event.status ?? "success").includes("error") ? "error" : "success"
  };
}

function readChangedFiles(event: Record<string, unknown>): string[] {
  const value = event.files_changed ?? event.filesChanged ?? event.changed_files;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof event.path === "string" && /patch|edit|write/i.test(String(event.type ?? ""))) return [event.path];
  return [];
}

function sumKnownProxyCosts(records: OpenAiUsageProxyRecord[]): number | undefined {
  const knownCosts = records
    .map((record) => record.costUsd)
    .filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost) && cost >= 0);
  if (!knownCosts.length) return undefined;
  return Number(knownCosts.reduce((sum, cost) => sum + cost, 0).toFixed(8));
}

function sumProxyUsage(records: OpenAiUsageProxyRecord[]): TokenUsage | undefined {
  if (!records.length) return undefined;
  return records.reduce<TokenUsage>((sum, record) => ({
    inputTokens: sum.inputTokens + record.usage.inputTokens,
    outputTokens: sum.outputTokens + record.usage.outputTokens,
    totalTokens: sum.totalTokens + record.usage.totalTokens,
    cacheReadInputTokens: (sum.cacheReadInputTokens ?? 0) + (record.usage.cacheReadInputTokens ?? 0)
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0 });
}
