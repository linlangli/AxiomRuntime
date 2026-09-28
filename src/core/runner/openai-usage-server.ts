import http from "node:http";
import { Agent, fetch, type Response } from "undici";
import { writeLog } from "../logs/log-service.js";
import { getProviderAuthScheme } from "../providers/provider-request-profile.js";
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  methodMayHaveBody,
  readRequestBody,
  streamResponseWithGate,
  writeResponseHead
} from "./openai-usage-http.js";
import {
  buildChatCompletionsResponsesSse,
  isResponsesStreamRequest,
  shouldFallbackResponsesToChat,
  type ResponsesChatFallbackResult
} from "./openai-usage-responses.js";
import { buildFailoverSseNotice } from "./failover-notice.js";
import { extractRequestModel, recordUsageFromResponse } from "./openai-usage-recording.js";
import type {
  OpenAiUsageProxy,
  OpenAiUsageProxyFailoverEvent,
  OpenAiUsageProxyMetrics,
  OpenAiUsageProxyRecord,
  OpenAiUsageProxyRoute,
  StartOpenAiUsageProxyInput
} from "./openai-usage-types.js";
import { getToolBaseUrl } from "./tool-runner.js";

const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 45_000;
const MAX_CONSECUTIVE_HEADERS_TIMEOUTS = 2;

export async function startOpenAiUsageProxy(input: StartOpenAiUsageProxyInput): Promise<OpenAiUsageProxy> {
  const engine = input.engine ?? (input.tool === "claude" ? "claude" : "codex");
  const routes = dedupeRoutes([{ provider: input.provider, model: input.model }, ...(input.fallbackRoutes ?? [])]);
  const upstreamHeadersTimeoutMs = normalizePositiveTimeout(input.upstreamHeadersTimeoutMs, DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS);
  const upstreamDispatcher = new Agent({ connections: 4, pipelining: 0, headersTimeout: upstreamHeadersTimeoutMs, bodyTimeout: 0 });
  const records: OpenAiUsageProxyRecord[] = [];
  const metrics = createEmptyMetrics();
  const consecutiveHeadersTimeouts = new Map<string, number>();
  let activeRouteIndex = 0;
  let pendingRouteIndex: number | null = null;

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    let requestBytes = 0;
    let requestShape: Record<string, unknown> = {};
    metrics.requestCount += 1;
    let finalized = false;
    const finalizeMetrics = (success: boolean, upstreamStatus?: number | string): void => {
      if (finalized) return;
      finalized = true;
      if (success) metrics.successCount += 1;
      else metrics.failureCount += 1;
      metrics.totalDurationMs += Date.now() - startedAt;
      if (upstreamStatus !== undefined) incrementStatusCount(metrics, upstreamStatus);
    };

    try {
      if (pendingRouteIndex !== null) {
        const from = routes[activeRouteIndex]!;
        const to = routes[pendingRouteIndex]!;
        activeRouteIndex = pendingRouteIndex;
        pendingRouteIndex = null;
        await emitFailover(input, { type: "confirmed", from, to, reason: "user_retried_after_partial_output" });
      }

      const originalRequestBody = await readRequestBody(req);
      requestBytes = originalRequestBody.length;
      requestShape = summarizeRequestShape(originalRequestBody);
      const canFailover = req.method === "POST" && requestBytes > 0;

      for (let routeIndex = activeRouteIndex; routeIndex < routes.length; routeIndex += 1) {
        const route = routes[routeIndex]!;
        const nextRoute = routes[routeIndex + 1];
        const requestBody = rewriteRequestModel(originalRequestBody, route.model);
        const requestModel = extractRequestModel(requestBody) ?? route.model;
        const responsesStream = engine === "codex" && isResponsesStreamRequest(req.url ?? "/", requestBody);
        const upstreamBaseUrl = getToolBaseUrl(engine, route.provider);
        const upstreamUrl = buildUpstreamUrl(upstreamBaseUrl, req.url ?? "/", { stripV1Prefix: engine === "codex" });
        const upstreamPath = new URL(upstreamUrl).pathname;
        const timeoutCount = consecutiveHeadersTimeouts.get(route.provider.name) ?? 0;

        await writeLog({
          category: "usage",
          action: "openai_usage_proxy_request",
          message: `Proxying ${input.tool} request for ${route.provider.name} / ${requestModel}`,
          metadata: { tool: input.tool, provider: route.provider.name, model: requestModel, path: upstreamPath, attempt: routeIndex - activeRouteIndex + 1 }
        });

        if (timeoutCount >= MAX_CONSECUTIVE_HEADERS_TIMEOUTS) {
          const reason = "headers_timeout_short_circuit";
          await input.onRouteResult?.(route, false, reason);
          if (nextRoute) {
            await emitFailover(input, { type: "automatic", from: route, to: nextRoute, reason });
            continue;
          }
          sendProxyError(res, 504, "AxiomRuntime timed out waiting for provider response headers.");
          finalizeMetrics(false, reason);
          return;
        }

        let upstreamResponse: Response;
        try {
          upstreamResponse = await fetch(upstreamUrl, {
            method: req.method,
            headers: buildUpstreamHeaders(req.headers, route.provider.apiKey, {
              authScheme: getProviderAuthScheme(route.provider, engine === "claude" ? "anthropic" : "openai"),
              includeAnthropicVersion: engine === "claude"
            }),
            body: requestBody.length && methodMayHaveBody(req.method) ? requestBody : undefined,
            dispatcher: upstreamDispatcher
          });
          consecutiveHeadersTimeouts.set(route.provider.name, 0);
        } catch (error) {
          const diagnostic = summarizeUpstreamError(error);
          const headersTimedOut = diagnostic.code === "UND_ERR_HEADERS_TIMEOUT";
          consecutiveHeadersTimeouts.set(route.provider.name, headersTimedOut ? timeoutCount + 1 : 0);
          const reason = headersTimedOut ? "headers_timeout" : diagnostic.code ?? "proxy_error";
          await logUpstreamError(input, route, requestModel, upstreamPath, requestBytes, requestShape, diagnostic, upstreamHeadersTimeoutMs);
          await input.onRouteResult?.(route, false, reason);
          if (nextRoute) {
            await emitFailover(input, { type: "automatic", from: route, to: nextRoute, reason });
            continue;
          }
          const code = diagnostic.code ? ` (${diagnostic.code})` : "";
          sendProxyError(res, headersTimedOut ? 504 : 502, `AxiomRuntime proxy failed: ${diagnostic.message}${code}`);
          finalizeMetrics(false, reason);
          return;
        }

        if (responsesStream && !isUsableEventStream(upstreamResponse)) {
          const nativeBody = await upstreamResponse.text().catch(() => "");
          const contentType = upstreamResponse.headers.get("content-type") ?? "";
          const outcome = { status: upstreamResponse.status, contentType, bodyText: nativeBody };
          if (shouldFallbackResponsesToChat(outcome)) {
            await writeLog({
              category: "usage",
              action: "openai_usage_proxy_responses_chat_fallback",
              message: `Responses protocol is unsupported for ${route.provider.name} / ${requestModel}; falling back to chat completions.`,
              metadata: { tool: input.tool, provider: route.provider.name, model: requestModel, status: outcome.status }
            });
            const chatResponse = await buildChatCompletionsResponsesSse({
              upstreamBaseUrl,
              requestBody,
              apiKey: route.provider.apiKey,
              authScheme: getProviderAuthScheme(route.provider, "openai"),
              dispatcher: upstreamDispatcher
            });
            const chatText = chatResponse.body.toString("utf8");
            if (shouldFailoverResponse(chatResponse.status, chatText) && nextRoute && canFailover) {
              const reason = `http_${effectiveResponseStatus(chatResponse.status, chatText)}`;
              await input.onRouteResult?.(route, false, reason);
              await emitFailover(input, { type: "automatic", from: route, to: nextRoute, reason });
              continue;
            }
            await sendBufferedUsageResponse(res, chatResponse, chatText, route, requestModel, input, records, metrics);
            activeRouteIndex = routeIndex;
            const success = chatResponse.status >= 200 && chatResponse.status < 400;
            await input.onRouteResult?.(route, success, `http_${chatResponse.status}`);
            finalizeMetrics(success, chatResponse.status);
            return;
          }

          if (shouldFailoverResponse(outcome.status, nativeBody) && nextRoute && canFailover) {
            const reason = `http_${effectiveResponseStatus(outcome.status, nativeBody)}`;
            await input.onRouteResult?.(route, false, reason);
            await emitFailover(input, { type: "automatic", from: route, to: nextRoute, reason });
            continue;
          }
          await sendBufferedUsageResponse(res, {
            status: outcome.status,
            statusText: upstreamResponse.statusText,
            contentType: outcome.contentType || "application/json; charset=utf-8",
            body: Buffer.from(nativeBody)
          }, nativeBody, route, requestModel, input, records, metrics);
          activeRouteIndex = routeIndex;
          const success = outcome.status >= 200 && outcome.status < 400;
          await input.onRouteResult?.(route, success, `http_${outcome.status}`);
          finalizeMetrics(success, outcome.status);
          return;
        }

        const contentType = upstreamResponse.headers.get("content-type") ?? "";
        if (isEventStreamContentType(contentType) && upstreamResponse.ok) {
          const streamed = await streamResponseWithGate(
            upstreamResponse,
            res,
            (buffer) => hasEffectiveStreamOutput(buffer, engine),
            { maxCaptureBytes: input.tool === "image" ? 32 * 1024 * 1024 : undefined }
          );
          if (streamed.error) {
            const diagnostic = summarizeUpstreamError(streamed.error);
            const reason = diagnostic.code ?? "stream_error";
            await input.onRouteResult?.(route, false, reason);
            if (!streamed.outputStarted && nextRoute && canFailover) {
              await emitFailover(input, { type: "automatic", from: route, to: nextRoute, reason });
              continue;
            }
            if (streamed.outputStarted && nextRoute && canFailover) {
              pendingRouteIndex = routeIndex + 1;
              const event: OpenAiUsageProxyFailoverEvent = { type: "confirmation_required", from: route, to: nextRoute, reason };
              await emitFailover(input, event);
              // 流已打开：把提示写回协议内，交给原生 TUI 排版，避免父进程插字节破坏整屏重绘。
              res.write(buildFailoverSseNotice(engine, event));
            }
            res.end();
            finalizeMetrics(false, reason);
            return;
          }
          const recordedUsage = await recordUsageFromResponse({
            text: streamed.captured.toString("utf8"),
            contentType,
            fallbackModel: requestModel,
            provider: route.provider.name,
            tool: input.tool,
            records,
            onUsage: input.onUsage
          });
          recordUsageMetric(metrics, recordedUsage);
          activeRouteIndex = routeIndex;
          await input.onRouteResult?.(route, true);
          res.end();
          finalizeMetrics(true, upstreamResponse.status);
          return;
        }

        const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
        const responseText = responseBody.toString("utf8");
        if (shouldFailoverResponse(upstreamResponse.status, responseText) && nextRoute && canFailover) {
          const reason = `http_${effectiveResponseStatus(upstreamResponse.status, responseText)}`;
          await input.onRouteResult?.(route, false, reason);
          await emitFailover(input, { type: "automatic", from: route, to: nextRoute, reason });
          continue;
        }
        writeResponseHead(res, upstreamResponse);
        const recordedUsage = await recordUsageFromResponse({
          text: responseText,
          contentType,
          fallbackModel: requestModel,
          provider: route.provider.name,
          tool: input.tool,
          records,
          onUsage: input.onUsage
        });
        recordUsageMetric(metrics, recordedUsage);
        res.end(responseBody);
        activeRouteIndex = routeIndex;
        await input.onRouteResult?.(route, upstreamResponse.ok, `http_${upstreamResponse.status}`);
        finalizeMetrics(upstreamResponse.ok, upstreamResponse.status);
        return;
      }
    } catch (error) {
      const diagnostic = summarizeUpstreamError(error);
      await writeLog({
        level: "error",
        category: "usage",
        action: "openai_usage_proxy_error",
        message: `AxiomRuntime proxy failed before completing the request: ${diagnostic.message}`,
        metadata: { tool: input.tool, requestBytes, ...requestShape, errorName: diagnostic.name, errorCode: diagnostic.code }
      });
      if (!res.headersSent) sendProxyError(res, 502, `AxiomRuntime proxy failed: ${diagnostic.message}`);
      else res.end();
      finalizeMetrics(false, diagnostic.code ?? "proxy_error");
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
  if (!address || typeof address === "string") throw new Error("Failed to start AxiomRuntime proxy.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}${engine === "codex" ? "/v1" : ""}`,
    async close() {
      const closeServer = server.listening
        ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve();
      await Promise.all([closeServer, upstreamDispatcher.close()]);
    },
    getRecords: () => [...records],
    getMetrics: () => snapshotMetrics(metrics)
  };
}

function dedupeRoutes(routes: OpenAiUsageProxyRoute[]): OpenAiUsageProxyRoute[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.provider.name}\0${route.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function emitFailover(input: StartOpenAiUsageProxyInput, event: OpenAiUsageProxyFailoverEvent): Promise<void> {
  await writeLog({
    level: "warn",
    category: "strategy",
    action: `provider_failover_${event.type}`,
    message: `Provider ${event.from.provider.name} -> ${event.to.provider.name}: ${event.reason}`,
    metadata: { type: event.type, from: event.from.provider.name, fromModel: event.from.model, to: event.to.provider.name, toModel: event.to.model, reason: event.reason }
  });
  await input.onFailover?.(event);
}

async function logUpstreamError(
  input: StartOpenAiUsageProxyInput,
  route: OpenAiUsageProxyRoute,
  model: string,
  upstreamPath: string,
  requestBytes: number,
  requestShape: Record<string, unknown>,
  diagnostic: ReturnType<typeof summarizeUpstreamError>,
  timeoutMs: number
): Promise<void> {
  await writeLog({
    level: "error",
    category: "usage",
    action: "openai_usage_proxy_upstream_error",
    message: `Upstream request failed for ${route.provider.name} / ${model}: ${diagnostic.message}`,
    metadata: {
      tool: input.tool,
      provider: route.provider.name,
      model,
      upstreamPath,
      requestBytes,
      ...requestShape,
      errorName: diagnostic.name,
      errorCode: diagnostic.code,
      errorSyscall: diagnostic.syscall,
      timeoutMs: diagnostic.code === "UND_ERR_HEADERS_TIMEOUT" ? timeoutMs : null
    }
  });
}

async function sendBufferedUsageResponse(
  res: http.ServerResponse,
  response: ResponsesChatFallbackResult,
  text: string,
  route: OpenAiUsageProxyRoute,
  requestModel: string,
  input: StartOpenAiUsageProxyInput,
  records: OpenAiUsageProxyRecord[],
  metrics: OpenAiUsageProxyMetrics
): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  res.setHeader("content-type", response.contentType);
  const recordedUsage = await recordUsageFromResponse({
    text,
    contentType: response.contentType,
    fallbackModel: requestModel,
    provider: route.provider.name,
    tool: input.tool,
    records,
    onUsage: input.onUsage
  });
  recordUsageMetric(metrics, recordedUsage);
  res.end(response.body);
}

function rewriteRequestModel(requestBody: Buffer, model: string): Buffer {
  if (!requestBody.length) return requestBody;
  try {
    const body = JSON.parse(requestBody.toString("utf8")) as Record<string, unknown>;
    if (typeof body.model !== "string") return requestBody;
    body.model = model;
    return Buffer.from(JSON.stringify(body));
  } catch {
    return requestBody;
  }
}

function shouldFailoverResponse(status: number, bodyText: string): boolean {
  const effective = effectiveResponseStatus(status, bodyText);
  return effective === 401 || effective === 403 || effective === 404
    || effective === 408 || effective === 409 || effective === 425 || effective === 429
    || effective >= 500;
}

function effectiveResponseStatus(status: number, bodyText: string): number {
  if (status < 200 || status >= 300) return status;
  const match = bodyText.replace(/\s+/g, " ").match(/status[_-]?code["']?\s*[:=]\s*["']?(\d{3})/i);
  return match ? Number(match[1]) : status;
}

function hasEffectiveStreamOutput(buffer: Buffer, engine: "claude" | "codex"): boolean {
  const text = buffer.toString("utf8");
  if (engine === "claude") {
    return /"type"\s*:\s*"(?:text_delta|thinking_delta|input_json_delta)"/.test(text);
  }
  return /"type"\s*:\s*"response\.(?:output_text|reasoning_text|function_call_arguments)\.delta"/.test(text)
    || /"(?:content|tool_calls)"\s*:\s*(?!null|""|\[\])/.test(text);
}

function isEventStreamContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

function isUsableEventStream(response: Response): boolean {
  return response.ok && isEventStreamContentType(response.headers.get("content-type") ?? "");
}

function normalizePositiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
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

function createEmptyMetrics(): OpenAiUsageProxyMetrics {
  return { requestCount: 0, successCount: 0, failureCount: 0, noUsageCount: 0, usageRecordCount: 0, totalDurationMs: 0, averageDurationMs: 0, upstreamStatusCounts: {} };
}

function recordUsageMetric(metrics: OpenAiUsageProxyMetrics, recordedUsage: boolean): void {
  if (recordedUsage) metrics.usageRecordCount += 1;
  else metrics.noUsageCount += 1;
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
