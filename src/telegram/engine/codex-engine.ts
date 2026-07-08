import type { ChildProcess } from "node:child_process";
import type { Engine, EngineExecuteParams, ExecutionResult, ProgressUpdate, ToolCallResult } from "./types.js";
import type { TokenUsage } from "../../core/types.js";
import { cleanupRuntime, createCommandPermissionRequest, prepareEngineRuntime, summarizeRuntime } from "./engine-utils.js";
import { extractJsonLines, spawnCapture, stripAnsi } from "./process-utils.js";
import { startOpenAiUsageProxy, type OpenAiUsageProxy, type OpenAiUsageProxyRecord } from "../../core/runner/openai-usage-proxy.js";
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
      });
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
        onStdout: (chunk) => handleCodexProgress(chunk, params.onProgress)
      }, (child) => this.processes.set(params.chatId, child));

      if (result.code !== 0) {
        throw new Error(formatCodexFailure(
          result.stderr || result.stdout || `Codex exited with code ${result.code}`,
          runtime.provider.name,
          runtime.model
        ));
      }
      await params.onProgress?.({ phase: "done" });
      return {
        ...parseCodexOutput(result.stdout, Date.now() - startTime),
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
    this.processes.get(chatId)?.kill("SIGTERM");
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
  providerOverride?: CodexProviderOverride
): string[] {
  const args = [
    "exec",
    ...buildCodexProviderOverrideArgs(providerOverride),
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
