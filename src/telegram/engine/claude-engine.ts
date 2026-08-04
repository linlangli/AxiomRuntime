import type { ChildProcess } from "node:child_process";
import type { Engine, EngineExecuteParams, ExecutionResult, ProgressUpdate, ToolCallResult } from "./types.js";
import { cleanupRuntime, createCommandPermissionRequest, formatEngineTimeout, prepareEngineRuntime, summarizeRuntime } from "./engine-utils.js";
import { createJsonLineAccumulator, extractJsonLines, spawnCapture, stripAnsi, terminateProcessTree } from "./process-utils.js";
import { requiresDangerousConfirmation } from "../interaction/approval.js";
import { writeTelegramLog } from "../log.js";
import { isRecord } from "../../core/utils/is-record.js";
import {
  CLAUDE_ROOT_PERMISSION_WARNING,
  resolveClaudePermissionMode,
  type ClaudePermissionMode,
  type ProcessIdentityOptions
} from "../../core/runner/claude-permission-policy.js";

export class ClaudeEngine implements Engine {
  readonly name = "claude" as const;
  private processes = new Map<number, ChildProcess>();
  private controllers = new Map<number, AbortController>();

  async execute(params: EngineExecuteParams): Promise<ExecutionResult> {
    const requestedPermissionMode = params.permissionMode ?? "default";
    const runtime = await prepareEngineRuntime("claude", params.providerName, params.modelName, requestedPermissionMode);
    const permissionMode = runtime.claudePermission?.effectiveMode ?? requestedPermissionMode;
    const controller = new AbortController();
    this.controllers.set(params.chatId, controller);
    const signal = params.signal ?? controller.signal;
    const startTime = Date.now();

    if (permissionMode === "bypassPermissions" && requiresDangerousConfirmation(params.prompt)) {
      const approved = await params.onPermission(createCommandPermissionRequest("Claude prompt", params.prompt));
      if (!approved) {
        cleanupRuntime(runtime);
        throw new Error("Dangerous command denied.");
      }
    }

    const args = buildClaudeArgs({
      prompt: params.prompt,
      model: runtime.model,
      settingsPath: runtime.claudeSettingsPath,
      permissionMode,
      resume: params.resume,
      allowedTools: params.allowedTools
    });

    const permissionWarning = runtime.claudePermission?.constrained ? CLAUDE_ROOT_PERMISSION_WARNING : null;
    await params.onProgress?.({ phase: "thinking", message: permissionWarning ?? "Claude started" });
    if (permissionWarning) {
      await writeTelegramLog({
        level: "warn",
        action: "claude_permission_constrained",
        message: permissionWarning,
        metadata: { requestedPermissionMode, effectivePermissionMode: permissionMode, reason: runtime.claudePermission?.reason }
      });
    }
    await writeTelegramLog({
      action: "claude_start",
      message: `Starting Claude for Telegram chat ${params.chatId}`,
      metadata: {
        ...summarizeRuntime(runtime.provider, runtime.model, "claude"),
        cwd: params.cwd,
        requestedPermissionMode,
        effectivePermissionMode: permissionMode
      }
    });

    try {
      const progressParser = createJsonLineAccumulator((event) => handleClaudeProgressEvent(event, params.onProgress));
      const result = await spawnCapture({
        command: runtime.command,
        args,
        cwd: params.cwd,
        env: {
          ...runtime.env,
          CLAUDE_CODE_HEADLESS: "1"
        },
        signal,
        timeoutMs: params.timeoutMs,
        onStdout: (chunk) => progressParser.push(chunk)
      }, (child) => this.processes.set(params.chatId, child));
      progressParser.end();

      if (result.timedOut) {
        throw new Error(formatEngineTimeout("Claude Code", params.timeoutMs, runtime.provider.name, runtime.model));
      }
      if (result.aborted) {
        throw new Error("任务已停止。");
      }
      if (result.code !== 0) {
        throw new Error(formatClaudeFailure(result.stdout, result.stderr, result.code));
      }
      const parsed = parseClaudeOutput(result.stdout, Date.now() - startTime);
      await params.onProgress?.({ phase: "done" });
      return {
        ...parsed,
        provider: runtime.provider.name,
        model: runtime.model
      };
    } finally {
      this.processes.delete(params.chatId);
      this.controllers.delete(params.chatId);
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

export function buildClaudeArgs(options: {
  prompt: string;
  model: string;
  settingsPath?: string | null;
  permissionMode: ClaudePermissionMode;
  resume?: string | null;
  allowedTools?: string[];
  uid?: ProcessIdentityOptions["uid"];
}): string[] {
  const resolution = resolveClaudePermissionMode(options.permissionMode, { uid: options.uid });
  const permissionMode = resolution.effectiveMode === "readOnly" ? "default" : resolution.effectiveMode;
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    "--settings",
    options.settingsPath ?? "",
    "--permission-mode",
    permissionMode,
    "--max-budget-usd",
    "20"
  ].filter(Boolean);
  if (options.resume) {
    args.push("--resume", options.resume);
  }
  if (options.allowedTools?.length) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (resolution.effectiveMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  }
  if (options.permissionMode === "readOnly") {
    args.push("--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch");
  }
  return args;
}

export function parseClaudeOutput(raw: string, duration: number): ExecutionResult {
  const events = extractJsonLines(raw);
  let response = "";
  let sessionId: string | undefined;
  let cost: number | undefined;
  const toolCalls: ToolCallResult[] = [];

  for (const event of events) {
    if (!isRecord(event)) continue;
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (typeof event.sessionId === "string") sessionId = event.sessionId;
    if (typeof event.total_cost_usd === "number") cost = event.total_cost_usd;
    if (typeof event.cost_usd === "number") cost = event.cost_usd;
    if (event.type === "result" && typeof event.result === "string") {
      response = event.result;
    }
    collectTextFromMessage(event, (text) => {
      if (!response.includes(text)) response += `${response ? "\n" : ""}${text}`;
    });
    collectToolCalls(event, toolCalls);
  }

  if (!response.trim()) {
    response = stripAnsi(raw).trim();
  }

  return {
    sessionId,
    response,
    toolCalls,
    filesChanged: extractFilesChanged(toolCalls),
    cost,
    duration
  };
}

export function formatClaudeFailure(stdout: string, stderr = "", code?: number | null): string {
  let terminalResult = "";
  for (const event of extractJsonLines(stdout)) {
    if (!isRecord(event) || event.type !== "result") continue;
    if (typeof event.result === "string" && event.result.trim()) {
      terminalResult = event.result.trim();
    }
  }

  const stderrText = stripAnsi(stderr).trim();
  const plainStdout = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("{"))
    .slice(-6)
    .join("\n");
  const diagnostics = [stderrText, terminalResult, plainStdout]
    .filter((value, index, values) => value && values.indexOf(value) === index);
  return diagnostics.join("\n") || `Claude exited with code ${code ?? "unknown"}.`;
}

function handleClaudeProgressEvent(event: unknown, onProgress?: (update: ProgressUpdate) => void | Promise<void>): void {
  if (!onProgress) return;
  if (!isRecord(event) || event.type !== "assistant") return;
  const tool = findFirstToolName(event);
  if (tool) {
    void onProgress({ phase: "tool_calling", tool });
  } else {
    const responseText = readMessageText(event);
    void onProgress({ phase: "writing", responseText: responseText || undefined });
  }
}

function readMessageText(event: Record<string, unknown>): string {
  const parts: string[] = [];
  collectTextFromMessage(event, (text) => {
    if (text.trim()) parts.push(text.trim());
  });
  return parts.join("\n");
}

function collectTextFromMessage(event: Record<string, unknown>, add: (text: string) => void): void {
  const message = isRecord(event.message) ? event.message : event;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      add(item.text);
    }
  }
}

function collectToolCalls(event: Record<string, unknown>, calls: ToolCallResult[]): void {
  const message = isRecord(event.message) ? event.message : event;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const item of content) {
    if (isRecord(item) && item.type === "tool_use") {
      calls.push({
        tool: String(item.name ?? "tool"),
        input: isRecord(item.input) ? item.input : {},
        output: "",
        status: "success"
      });
    }
  }
}

function findFirstToolName(event: Record<string, unknown>): string | undefined {
  const message = isRecord(event.message) ? event.message : event;
  const content = Array.isArray(message.content) ? message.content : [];
  const tool = content.find((item) => isRecord(item) && item.type === "tool_use");
  return isRecord(tool) ? String(tool.name ?? "") || undefined : undefined;
}

function extractFilesChanged(calls: ToolCallResult[]): string[] {
  const files = new Set<string>();
  for (const call of calls) {
    const filePath = call.input.file_path ?? call.input.path;
    if (typeof filePath === "string" && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.tool)) {
      files.add(filePath);
    }
  }
  return [...files];
}
