import { recordProviderRuntimeFailure, recordProviderRuntimeSuccess } from "../config/cache-store.js";
import { writeLog } from "../logs/log-service.js";
import { resolveExactProviderForTool } from "../runner/fallback.js";
import { resolveToolCommand } from "../runner/command-resolver.js";
import { startOpenAiUsageProxy } from "../runner/openai-usage-proxy.js";
import { extractJsonLines, spawnCapture, stripAnsi } from "../runner/process-capture.js";
import { buildRunnerEnv, cleanupTemporaryFiles, writeTemporaryClaudeSettings } from "../runner/tool-runner.js";
import { isRecord } from "../utils/is-record.js";
import type { ReviewAgentPort, ReviewAgentRequest, ReviewAgentResult } from "./types.js";

const DEFAULT_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;

export class CliReviewAgent implements ReviewAgentPort {
  async execute(request: ReviewAgentRequest): Promise<ReviewAgentResult> {
    const { provider, model } = await resolveExactProviderForTool(request.engine, request.provider, request.model);
    const command = resolveToolCommand(request.engine);
    if (!command) {
      throw new Error(`找不到 ${displayEngine(request.engine)} CLI，请运行 \`ai doctor\` 检查本地安装。`);
    }

    const usageProxy = await startOpenAiUsageProxy({
      provider,
      model,
      tool: request.engine,
      engine: request.engine
    });
    const temporaryFiles: string[] = [];
    try {
      const routedProvider = { ...provider, baseUrl: usageProxy.baseUrl };
      const settingsPath = request.engine === "claude"
        ? writeTemporaryClaudeSettings(routedProvider, {
            permissionMode: request.mode === "readOnly" ? "readOnly" : "safeDefault"
          })
        : null;
      if (settingsPath) temporaryFiles.push(settingsPath);
      const args = buildReviewAgentArgs({
        ...request,
        model,
        baseUrl: usageProxy.baseUrl,
        settingsPath
      });
      const env = {
        ...buildRunnerEnv(request.engine, routedProvider, model),
        AI_GATEWAY_SOURCE: "review",
        CLAUDE_CODE_HEADLESS: "1",
        OPENAI_API_KEY: provider.apiKey,
        OPENAI_BASE_URL: usageProxy.baseUrl,
        AI_GATEWAY_BASE_URL: usageProxy.baseUrl
      };

      await writeLog({
        category: "usage",
        action: "review_agent_start",
        message: `Starting ${request.engine} review agent: ${provider.name} / ${model}`,
        metadata: {
          engine: request.engine,
          provider: provider.name,
          model,
          mode: request.mode,
          cwd: request.cwd
        }
      });
      const timeoutMs = readReviewTimeout();
      const result = await spawnCapture({ command, args, cwd: request.cwd, env, timeoutMs });

      if (result.timedOut) {
        throw new Error(`${displayEngine(request.engine)} 审阅超过 ${formatDuration(timeoutMs)} 仍未完成，已超时。`);
      }
      if (result.aborted) {
        throw new Error(`${displayEngine(request.engine)} 审阅已中止。`);
      }
      const structuredFailure = extractReviewFailure(request.engine, result.stdout, result.stderr);
      if (structuredFailure) {
        throw new Error(`审阅模型执行失败：${structuredFailure}`);
      }
      if (result.code !== 0) {
        throw new Error(formatReviewAgentFailure(request.engine, result.stdout, result.stderr, result.code));
      }
      const response = parseReviewAgentResponse(request.engine, result.stdout);
      if (!response.trim()) {
        throw new Error(`${displayEngine(request.engine)} 审阅结束但没有返回内容。`);
      }
      await recordProviderRuntimeSuccess(provider.name);
      return { engine: request.engine, provider: provider.name, model, response };
    } catch (error) {
      await recordProviderRuntimeFailure(provider.name, error).catch(() => undefined);
      throw error;
    } finally {
      cleanupTemporaryFiles(temporaryFiles);
      await usageProxy.close().catch(() => undefined);
    }
  }
}

export function buildReviewAgentArgs(input: ReviewAgentRequest & {
  baseUrl: string;
  settingsPath: string | null;
}): string[] {
  if (input.engine === "claude") {
    const allowedTools = buildClaudeAllowedTools(input);
    const availableTools = input.mode === "readOnly"
      ? "Read,Grep,Glob"
      : input.scopeFiles?.length
        ? "Read,Edit,Write"
        : "Read";
    return [
      "-p",
      input.prompt,
      "--bare",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      input.model,
      "--settings",
      input.settingsPath ?? "",
      "--permission-mode",
      input.mode === "readOnly" ? "default" : "acceptEdits",
      "--tools",
      availableTools,
      "--allowedTools",
      allowedTools,
      "--disable-slash-commands",
      "--max-budget-usd",
      "20"
    ].filter(Boolean);
  }

  const providerId = "ai_gateway_review";
  return [
    "-a",
    "never",
    "-s",
    input.mode === "readOnly" ? "read-only" : "workspace-write",
    "exec",
    "-c",
    `model_provider=${tomlString(providerId)}`,
    "-c",
    `model_providers.${providerId}.name=${tomlString("AI Gateway Review")}`,
    "-c",
    `model_providers.${providerId}.base_url=${tomlString(input.baseUrl)}`,
    "-c",
    `model_providers.${providerId}.env_key=${tomlString("OPENAI_API_KEY")}`,
    "-c",
    `model_providers.${providerId}.wire_api=${tomlString("responses")}`,
    "--json",
    "--skip-git-repo-check",
    "-m",
    input.model,
    "-C",
    input.cwd,
    input.prompt
  ];
}

export function parseReviewAgentResponse(engine: ReviewAgentRequest["engine"], raw: string): string {
  const events = extractJsonLines(raw);
  let response = "";
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (engine === "claude") {
      if (event.type === "result" && typeof event.result === "string") response = event.result;
      continue;
    }
    const item = isRecord(event.item) ? event.item : null;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      response = item.text;
    } else if (typeof event.message === "string") {
      response = event.message;
    }
  }
  return response.trim() || stripAnsi(raw).trim();
}

export function formatReviewAgentFailure(engine: ReviewAgentRequest["engine"], stdout: string, stderr: string, code: number | null): string {
  const structuredFailure = extractReviewFailure(engine, stdout, stderr);
  if (structuredFailure) return `审阅模型执行失败：${structuredFailure}`;

  const text = stripAnsi([stderr, stdout].filter((value) => value.trim()).join("\n")).trim();
  const tail = text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !isHookDiagnostic(line))
    .map((line) => line.length > 1000 ? `${line.slice(0, 1000)}…` : line)
    .slice(-8)
    .join("\n");
  return tail ? `审阅模型执行失败：\n${tail}` : `${displayEngine(engine)} 进程异常退出（退出码：${code ?? "未知"}）。`;
}

function extractReviewFailure(engine: ReviewAgentRequest["engine"], stdout: string, stderr: string): string | null {
  const events = [...extractJsonLines(stdout), ...extractJsonLines(stderr)];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event)) continue;
    const type = typeof event.type === "string" ? event.type : "";
    const terminalReason = typeof event.terminal_reason === "string" ? event.terminal_reason : "";
    const isFailure = event.is_error === true
      || type === "error"
      || type.endsWith(".failed")
      || terminalReason === "blocking_limit";
    if (!isFailure) continue;

    const message = readFailureMessage(event);
    if (message) return normalizeFailureMessage(message);
  }
  if (engine === "claude" && /prompt is too long/i.test(`${stdout}\n${stderr}`)) {
    return normalizeFailureMessage("Prompt is too long");
  }
  return null;
}

function readFailureMessage(event: Record<string, unknown>): string | null {
  for (const value of [event.result, event.message, event.error, event.detail]) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (isRecord(value)) {
      for (const nested of [value.message, value.error, value.detail]) {
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      }
    }
  }
  return null;
}

function normalizeFailureMessage(message: string): string {
  if (/prompt is too long/i.test(message)) {
    return "审阅内容过长，超出模型上下文限制；请缩小提交范围后重试。";
  }
  if (/autocompact is thrashing|context refilled to the limit/i.test(message)) {
    return "修复模型上下文在连续压缩后仍超出限制；已限制修复范围，请拆分问题后重试。";
  }
  return message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
}

function buildClaudeAllowedTools(input: ReviewAgentRequest): string {
  if (input.mode === "readOnly") {
    return "Read,Grep,Glob";
  }
  if (!input.scopeFiles?.length) {
    return "Read(./AGENTS.md),Read(./CLAUDE.md)";
  }
  const paths = new Set(["AGENTS.md", "CLAUDE.md", ...input.scopeFiles]);
  const tools: string[] = [];
  for (const file of paths) {
    const scopedPath = `./${file.replace(/^\.\//, "")}`;
    tools.push(`Read(${scopedPath})`);
    if (file !== "AGENTS.md" && file !== "CLAUDE.md") {
      tools.push(`Edit(${scopedPath})`, `Write(${scopedPath})`);
    }
  }
  return tools.join(",");
}

function isHookDiagnostic(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) && parsed.type === "system" && parsed.subtype === "hook_response";
  } catch {
    return false;
  }
}

function displayEngine(engine: ReviewAgentRequest["engine"]): string {
  return engine === "claude" ? "Claude Code" : "Codex";
}

function readReviewTimeout(): number {
  const parsed = Number(process.env.AI_GATEWAY_REVIEW_TIMEOUT_MS ?? DEFAULT_REVIEW_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_REVIEW_TIMEOUT_MS;
}

function formatDuration(milliseconds: number): string {
  return `${Math.ceil(milliseconds / 60_000)} 分钟`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
