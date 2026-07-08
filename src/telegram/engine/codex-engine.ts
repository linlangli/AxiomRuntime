import type { ChildProcess } from "node:child_process";
import type { Engine, EngineExecuteParams, ExecutionResult, ProgressUpdate, ToolCallResult } from "./types.js";
import { cleanupRuntime, createCommandPermissionRequest, prepareEngineRuntime, summarizeRuntime } from "./engine-utils.js";
import { extractJsonLines, spawnCapture, stripAnsi } from "./process-utils.js";
import { requiresDangerousConfirmation } from "../interaction/approval.js";
import { writeTelegramLog } from "../log.js";

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

    const args = buildCodexArgs(params.prompt, runtime.model, params.cwd, permissionMode);
    await params.onProgress?.({ phase: "thinking", message: "Codex started" });
    await writeTelegramLog({
      action: "codex_start",
      message: `Starting Codex for Telegram chat ${params.chatId}`,
      metadata: { ...summarizeRuntime(runtime.provider, runtime.model, "codex"), cwd: params.cwd }
    });

    try {
      const result = await spawnCapture({
        command: runtime.command,
        args,
        cwd: params.cwd,
        env: runtime.env,
        signal,
        onStdout: (chunk) => handleCodexProgress(chunk, params.onProgress)
      }, (child) => this.processes.set(params.chatId, child));

      if (result.code !== 0) {
        throw new Error(stripAnsi(result.stderr || result.stdout || `Codex exited with code ${result.code}`));
      }
      await params.onProgress?.({ phase: "done" });
      return {
        ...parseCodexOutput(result.stdout, Date.now() - startTime),
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
    this.processes.get(chatId)?.kill("SIGTERM");
    this.controllers.delete(chatId);
    this.processes.delete(chatId);
  }
}

export function buildCodexArgs(prompt: string, model: string, cwd: string, permissionMode: string): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-m",
    model,
    "-C",
    cwd
  ];

  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (permissionMode === "acceptEdits") {
    args.unshift("-a", "never");
    args.push("-s", "workspace-write");
  } else {
    args.unshift("-a", "on-request");
    args.push("-s", "workspace-write");
  }

  args.push(prompt);
  return args;
}

export function parseCodexOutput(raw: string, duration: number): ExecutionResult {
  const events = extractJsonLines(raw);
  let response = "";
  let sessionId: string | undefined;
  const toolCalls: ToolCallResult[] = [];
  const filesChanged = new Set<string>();

  for (const event of events) {
    if (!isRecord(event)) continue;
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (typeof event.sessionId === "string") sessionId = event.sessionId;
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

function handleCodexProgress(chunk: string, onProgress?: (update: ProgressUpdate) => void | Promise<void>): void {
  if (!onProgress) return;
  for (const event of extractJsonLines(chunk)) {
    if (!isRecord(event)) continue;
    const toolCall = readCodexToolCall(event);
    if (toolCall) {
      void onProgress({ phase: "tool_calling", tool: toolCall.tool });
      continue;
    }
    if (String(event.type ?? "").includes("message")) {
      void onProgress({ phase: "writing" });
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
