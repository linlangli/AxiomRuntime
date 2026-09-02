import http from "node:http";
import { Agent, fetch, type Response } from "undici";
import { writeLog } from "../logs/log-service.js";
import type { RunToolType } from "../types.js";
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  methodMayHaveBody,
  readRequestBody,
  streamResponse,
  writeResponseHead
} from "./openai-usage-http.js";
import {
  buildChatCompletionsResponsesSse,
  isResponsesStreamRequest,
  shouldFallbackResponsesToChat,
  type ResponsesChatFallbackInput
} from "./openai-usage-responses.js";
import { extractRequestModel, recordUsageFromResponse } from "./openai-usage-recording.js";
import type { OpenAiUsageProxy, OpenAiUsageProxyMetrics, OpenAiUsageProxyRecord, StartOpenAiUsageProxyInput } from "./openai-usage-types.js";
import { getToolBaseUrl } from "./tool-runner.js";

const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 45_000;
const MAX_CONSECUTIVE_HEADERS_TIMEOUTS = 2;

export async function startOpenAiUsageProxy(input: StartOpenAiUsageProxyInput): Promise<OpenAiUsageProxy> {
  const engine = input.engine ?? (input.tool === "claude" ? "claude" : "codex");
  const upstreamBaseUrl = getToolBaseUrl(engine, input.provider);
  const upstreamHeadersTimeoutMs = normalizePositiveTimeout(
    input.upstreamHeadersTimeoutMs,
    DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS
  );
  // Codex already retries failed Responses requests. Give those retries fresh
  // upstream connections so a stale gateway keep-alive socket cannot poison an
  // entire turn with immediate fetch failures.
  const upstreamDispatcher = new Agent({
    connections: 4,
    pipelining: 0,
    headersTimeout: upstreamHeadersTimeoutMs,
    bodyTimeout: 0
  });
  const records: OpenAiUsageProxyRecord[] = [];
  const metrics = createEmptyMetrics();
  let consecutiveHeadersTimeouts = 0;

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    let requestModel = input.model;
    let requestBytes = 0;
    let requestShape: Record<string, unknown> = {};
    let upstreamPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    metrics.requestCount += 1;
    let finalized = false;
    const finalizeMetrics = (success: boolean, upstreamStatus?: number | string): void => {
      if (finalized) return;
      finalized = true;
      if (success) {
        metrics.successCount += 1;
      } else {
        metrics.failureCount += 1;
      }
      metrics.totalDurationMs += Date.now() - startedAt;
      if (upstreamStatus !== undefined) {
        incrementStatusCount(metrics, upstreamStatus);
      }
    };
    try {
      const requestBody = await readRequestBody(req);
      requestModel = extractRequestModel(requestBody) ?? input.model;
      requestBytes = requestBody.length;
      requestShape = summarizeRequestShape(requestBody);
      const responsesStream = engine === "codex" && isResponsesStreamRequest(req.url ?? "/", requestBody);
      void writeLog({
        category: "usage",
        action: "openai_usage_proxy_request",
        message: `Proxying ${input.tool} request for ${input.provider.name} / ${requestModel}`,
        metadata: {
          tool: input.tool,
          provider: input.provider.name,
          model: requestModel,
          path: new URL(req.url ?? "/", "http://127.0.0.1").pathname
        }
      });

      const upstreamUrl = buildUpstreamUrl(upstreamBaseUrl, req.url ?? "/", {
        stripV1Prefix: engine === "codex"
      });
      upstreamPath = new URL(upstreamUrl).pathname;
      if (consecutiveHeadersTimeouts >= MAX_CONSECUTIVE_HEADERS_TIMEOUTS) {
        await writeLog({
          level: "warn",
          category: "usage",
          action: "openai_usage_proxy_timeout_short_circuit",
          message: `Skipping another stalled upstream attempt for ${input.provider.name} / ${requestModel}.`,
          metadata: {
            tool: input.tool,
            provider: input.provider.name,
            model: requestModel,
            upstreamPath,
            requestBytes,
            ...requestShape,
            timeoutMs: upstreamHeadersTimeoutMs,
            consecutiveTimeouts: consecutiveHeadersTimeouts
          }
        });
        sendProxyError(res, 504, "AI Gateway timed out waiting for provider response headers.");
        finalizeMetrics(false, "headers_timeout_short_circuit");
        return;
      }
      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers: buildUpstreamHeaders(req.headers, input.provider.apiKey, {
          includeAnthropicApiKey: engine === "claude",
          includeAuthorization: engine !== "claude"
        }),
        body: requestBody.length && methodMayHaveBody(req.method) ? requestBody : undefined,
        dispatcher: upstreamDispatcher
      });
      consecutiveHeadersTimeouts = 0;

      // Native Responses is attempted first. Only when the upstream cannot speak
      // the Responses protocol do we translate the request through chat
      // completions; transient/no-channel errors are passed through untouched so
      // provider rotation can react to them.
      if (responsesStream && !isUsableEventStream(upstreamResponse)) {
        const nativeBody = await upstreamResponse.text().catch(() => "");
        const outcome = {
          status: upstreamResponse.status,
          contentType: upstreamResponse.headers.get("content-type") ?? "",
          bodyText: nativeBody
        };
        if (shouldFallbackResponsesToChat(outcome)) {
          void writeLog({
            category: "usage",
            action: "openai_usage_proxy_responses_chat_fallback",
            message: `Responses protocol is unsupported for ${input.provider.name} / ${requestModel}; falling back to chat completions.`,
            metadata: {
              tool: input.tool,
              provider: input.provider.name,
              model: requestModel,
              status: outcome.status
            }
          });
          await sendChatCompletionsResponsesSse({
            upstreamBaseUrl,
            requestBody,
            apiKey: input.provider.apiKey,
            dispatcher: upstreamDispatcher,
            requestModel,
            provider: input.provider.name,
            tool: input.tool,
            records,
            onUsage: input.onUsage,
            metrics,
            res
          }).then((result) => finalizeMetrics(result.status >= 200 && result.status < 400, result.status));
          return;
        }
        // Not a protocol problem (e.g. 503 no-channel): pass the native error
        // through so the caller and provider rotation see the real cause.
        res.statusCode = outcome.status;
        res.statusMessage = upstreamResponse.statusText;
        res.setHeader("content-type", outcome.contentType || "application/json; charset=utf-8");
        const recordedUsage = await recordUsageFromResponse({
          text: nativeBody,
          contentType: outcome.contentType,
          fallbackModel: requestModel,
          provider: input.provider.name,
          tool: input.tool,
          records,
          onUsage: input.onUsage
        });
        recordUsageMetric(metrics, recordedUsage);
        res.end(nativeBody);
        finalizeMetrics(outcome.status >= 200 && outcome.status < 400, outcome.status);
        return;
      }

      writeResponseHead(res, upstreamResponse);
      const captured = await streamResponse(upstreamResponse, res, {
        maxCaptureBytes: input.tool === "image" ? 32 * 1024 * 1024 : undefined
      });
      const recordedUsage = await recordUsageFromResponse({
        text: captured.toString("utf8"),
        contentType: upstreamResponse.headers.get("content-type") ?? "",
        fallbackModel: requestModel,
        provider: input.provider.name,
        tool: input.tool,
        records,
        onUsage: input.onUsage
      });
      recordUsageMetric(metrics, recordedUsage);
      res.end();
      finalizeMetrics(upstreamResponse.status >= 200 && upstreamResponse.status < 400, upstreamResponse.status);
    } catch (error) {
      const diagnostic = summarizeUpstreamError(error);
      const headersTimedOut = diagnostic.code === "UND_ERR_HEADERS_TIMEOUT";
      consecutiveHeadersTimeouts = headersTimedOut ? consecutiveHeadersTimeouts + 1 : 0;
      await writeLog({
        level: "error",
        category: "usage",
        action: "openai_usage_proxy_upstream_error",
        message: `OpenAI upstream request failed for ${input.provider.name} / ${requestModel}: ${diagnostic.message}`,
        metadata: {
          tool: input.tool,
          provider: input.provider.name,
          model: requestModel,
          upstreamPath,
          requestBytes,
          ...requestShape,
          errorName: diagnostic.name,
          errorCode: diagnostic.code,
          errorSyscall: diagnostic.syscall,
          timeoutMs: headersTimedOut ? upstreamHeadersTimeoutMs : null,
          consecutiveTimeouts: headersTimedOut ? consecutiveHeadersTimeouts : 0
        }
      });
      const code = diagnostic.code ? ` (${diagnostic.code})` : "";
      sendProxyError(
        res,
        headersTimedOut ? 504 : 502,
        `AI Gateway proxy failed: ${diagnostic.message}${code}`
      );
      finalizeMetrics(false, headersTimedOut ? "headers_timeout" : "proxy_error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      void upstreamDispatcher.close();
      reject(error);
    };
    server.once("error", onListenError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onListenError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start AI Gateway OpenAI proxy.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}${engine === "codex" ? "/v1" : ""}`,
    async close() {
      const closeServer = server.listening
        ? new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          })
        : Promise.resolve();
      await Promise.all([closeServer, upstreamDispatcher.close()]);
    },
    getRecords() {
      return [...records];
    },
    getMetrics() {
      return snapshotMetrics(metrics);
    }
  };
}

function normalizePositiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function sendProxyError(res: http.ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: { message } }));
}

function summarizeRequestShape(requestBody: Buffer): Record<string, unknown> {
  try {
    const body = JSON.parse(requestBody.toString("utf8")) as Record<string, unknown>;
    return {
      stream: body.stream === true,
      inputItems: Array.isArray(body.input) ? body.input.length : typeof body.input === "string" ? 1 : 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0
    };
  } catch {
    return { stream: null, inputItems: null, toolCount: null };
  }
}

function summarizeUpstreamError(error: unknown): { name: string; message: string; code: string | null; syscall: string | null } {
  const top = error instanceof Error ? error : new Error(String(error));
  const cause = top.cause && typeof top.cause === "object" ? top.cause as Record<string, unknown> : null;
  return {
    name: cause && typeof cause.name === "string" ? cause.name : top.name,
    message: cause && typeof cause.message === "string" ? cause.message : top.message,
    code: cause && typeof cause.code === "string" ? cause.code : null,
    syscall: cause && typeof cause.syscall === "string" ? cause.syscall : null
  };
}

type SendChatCompletionsResponsesSseInput = ResponsesChatFallbackInput & {
  requestModel: string;
  provider: string;
  tool: RunToolType;
  records: OpenAiUsageProxyRecord[];
  onUsage?: (record: OpenAiUsageProxyRecord) => void | Promise<void>;
  metrics: OpenAiUsageProxyMetrics;
  res: http.ServerResponse;
};

async function sendChatCompletionsResponsesSse(
  input: SendChatCompletionsResponsesSseInput
): Promise<{ status: number }> {
  const response = await buildChatCompletionsResponsesSse({
    upstreamBaseUrl: input.upstreamBaseUrl,
    requestBody: input.requestBody,
    apiKey: input.apiKey,
    dispatcher: input.dispatcher
  });
  input.res.statusCode = response.status;
  input.res.statusMessage = response.statusText;
  input.res.setHeader("content-type", response.contentType);
  const recordedUsage = await recordUsageFromResponse({
    text: response.body.toString("utf8"),
    contentType: response.contentType,
    fallbackModel: input.requestModel,
    provider: input.provider,
    tool: input.tool,
    records: input.records,
    onUsage: input.onUsage
  });
  recordUsageMetric(input.metrics, recordedUsage);
  input.res.end(response.body);
  return { status: response.status };
}

function isUsableEventStream(response: Response): boolean {
  if (!response.ok) return false;
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

function createEmptyMetrics(): OpenAiUsageProxyMetrics {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    noUsageCount: 0,
    usageRecordCount: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    upstreamStatusCounts: {}
  };
}

function recordUsageMetric(metrics: OpenAiUsageProxyMetrics, recordedUsage: boolean): void {
  if (recordedUsage) {
    metrics.usageRecordCount += 1;
  } else {
    metrics.noUsageCount += 1;
  }
}

function incrementStatusCount(metrics: OpenAiUsageProxyMetrics, status: number | string): void {
  const key = String(status);
  metrics.upstreamStatusCounts[key] = (metrics.upstreamStatusCounts[key] ?? 0) + 1;
}

function snapshotMetrics(metrics: OpenAiUsageProxyMetrics): OpenAiUsageProxyMetrics {
  return {
    ...metrics,
    averageDurationMs: metrics.requestCount ? metrics.totalDurationMs / metrics.requestCount : 0,
    upstreamStatusCounts: { ...metrics.upstreamStatusCounts }
  };
}
