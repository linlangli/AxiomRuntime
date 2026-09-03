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
      throw new Error(`Failed to find ${request.engine} CLI. Run \`ai doctor\` to check local CLI installation.`);
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
        throw new Error(`${request.engine} review timed out after ${formatDuration(timeoutMs)}.`);
      }
      if (result.aborted) {
        throw new Error(`${request.engine} review was aborted.`);
      }
      if (result.code !== 0) {
        throw new Error(formatAgentFailure(request.engine, result.stdout, result.stderr, result.code));
      }
      const response = parseReviewAgentResponse(request.engine, result.stdout);
      if (!response.trim()) {
        throw new Error(`${request.engine} review completed without a response.`);
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
    const allowedTools = input.mode === "readOnly"
      ? "Read,Grep,Glob"
      : "Read,Grep,Glob,Edit,Write";
    return [
      "-p",
      input.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      input.model,
      "--settings",
      input.settingsPath ?? "",
      "--permission-mode",
      input.mode === "readOnly" ? "default" : "acceptEdits",
      "--allowedTools",
      allowedTools,
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

function formatAgentFailure(engine: ReviewAgentRequest["engine"], stdout: string, stderr: string, code: number | null): string {
  const text = stripAnsi([stderr, stdout].filter((value) => value.trim()).join("\n")).trim();
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
  return tail || `${engine} exited with code ${code ?? "unknown"}.`;
}

function readReviewTimeout(): number {
  const parsed = Number(process.env.AI_GATEWAY_REVIEW_TIMEOUT_MS ?? DEFAULT_REVIEW_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_REVIEW_TIMEOUT_MS;
}

function formatDuration(milliseconds: number): string {
  return `${Math.ceil(milliseconds / 60_000)} minute(s)`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
