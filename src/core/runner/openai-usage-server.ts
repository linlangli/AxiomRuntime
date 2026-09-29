import http from "node:http";
import { fetch, type Dispatcher, type Response } from "undici";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { writeLog } from "../logs/log-service.js";
import { getProviderAuthScheme } from "../providers/provider-request-profile.js";
import {
  createUpstreamDispatcher,
  resolveProviderProxy
} from "../network/proxy.js";
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
const DEFAULT_MAX_ATTEMPTS_PER_ROUTE = 2;
const DEFAULT_RETRY_BACKOFF_MS = 300;

export async function startOpenAiUsageProxy(input: StartOpenAiUsageProxyInput): Promise<OpenAiUsageProxy> {
  const engine = input.engine ?? (input.tool === "claude" ? "claude" : "codex");
  const routes = dedupeRoutes([{ provider: input.provider, model: input.model }, ...(input.fallbackRoutes ?? [])]);
  const upstreamHeadersTimeoutMs = normalizePositiveTimeout(input.upstreamHeadersTimeoutMs, DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS);
  const maxAttemptsPerRoute = normalizePositiveTimeout(input.maxAttemptsPerRoute, DEFAULT_MAX_ATTEMPTS_PER_ROUTE);
  const retryBackoffMs = normalizeNonNegativeTimeout(input.retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS);
  // 按代理 URL 分派：Provider 级 proxyUrl 覆盖 runtime.json 全局默认。dedupeRoutes 可能重复
  // Provider，按 URL 键共享连接池；实例随 proxy.close() 统一关闭。
  const globalProxyUrl = input.globalProxyUrl !== undefined
    ? input.globalProxyUrl
    : (await loadRuntimeConfig()).proxyUrl ?? null;
  const dispatchersByUrl = new Map<string, Dispatcher>();
  const dispatcherFor = (route: OpenAiUsageProxyRoute): Dispatcher => {
    const key = resolveProviderProxy(route.provider, globalProxyUrl) ?? "";
    let dispatcher = dispatchersByUrl.get(key);
    if (!dispatcher) {
      dispatcher = createUpstreamDispatcher(key || null, { headersTimeout: upstreamHeadersTimeoutMs });
      dispatchersByUrl.set(key, dispatcher);
    }
    return dispatcher;
  };
  const closeDispatchers = (): Promise<void[]> =>
    Promise.all([...dispatchersByUrl.values()].map((dispatcher) => dispatcher.close().catch(() => undefined)));
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
      // 只有真正会产生补全的模型端点才允许轮转。count_tokens 这类辅助端点在很多中转站上
      // 并不存在，它的 404 不代表 Provider 不可用，不能据此烧掉整条候选链。
      const modelInvocation = isModelInvocationRequest(req.method, req.url ?? "/");
      const canFailover = req.method === "POST" && requestBytes > 0 && modelInvocation;

      let routeIndex = activeRouteIndex;
      let attempt = 1;
      while (routeIndex < routes.length) {
        const route = routes[routeIndex]!;
        const nextRoute = routes[routeIndex + 1];
        // 记账已由 handleFailure 写过，避免落地分支再补一次健康失败。
        let failureRecorded = false;
        // 瞬时失败先在同一个 Provider 上原地重试，重试额度耗尽（或失败本身不可重试）才换 Provider。
        const handleFailure = async (
          reason: string,
          retryable: boolean,
          failoverAllowed: boolean
        ): Promise<"retry" | "failover" | "exhausted"> => {
          if (retryable && attempt < maxAttemptsPerRoute) {
            const delayMs = retryBackoffMs * 2 ** (attempt - 1);
            await writeLog({
              level: "warn",
              category: "strategy",
              action: "provider_retry",
              message: `Retrying ${route.provider.name} / ${route.model} after ${reason} (attempt ${attempt + 1}/${maxAttemptsPerRoute}).`,
              metadata: { tool: input.tool, provider: route.provider.name, model: route.model, reason, attempt: attempt + 1, maxAttempts: maxAttemptsPerRoute, delayMs }
            });
            if (delayMs > 0) await delay(delayMs);
            attempt += 1;
            return "retry";
          }
          failureRecorded = true;
          await input.onRouteResult?.(route, false, reason);
          if (nextRoute && failoverAllowed) {
            await emitFailover(input, { type: "automatic", from: route, to: nextRoute, reason });
            routeIndex += 1;
            attempt = 1;
            return "failover";
          }
          return "exhausted";
        };
        const requestBody = rewriteRequestModel(originalRequestBody, route.model);
        const requestModel = extractRequestModel(requestBody) ?? route.model;
        const responsesStream = engine === "codex" && isResponsesStreamRequest(req.url ?? "/", requestBody);
        const upstreamBaseUrl = getToolBaseUrl(engine, route.provider);
        const upstreamUrl = buildUpstreamUrl(upstreamBaseUrl, req.url ?? "/", { stripV1Prefix: engine === "codex" });
        const upstreamPath = new URL(upstreamUrl).pathname;
        const upstreamDispatcher = dispatcherFor(route);
        const timeoutCount = consecutiveHeadersTimeouts.get(route.provider.name) ?? 0;

        await writeLog({
          category: "usage",
          action: "openai_usage_proxy_request",
          message: `Proxying ${input.tool} request for ${route.provider.name} / ${requestModel}`,
          metadata: { tool: input.tool, provider: route.provider.name, model: requestModel, path: upstreamPath, route: routeIndex - activeRouteIndex + 1, attempt }
        });

        if (timeoutCount >= MAX_CONSECUTIVE_HEADERS_TIMEOUTS) {
          // 该 Provider 已经连续超时到熔断阈值，原地重试只会再赔一个超时窗口。
          const reason = "headers_timeout_short_circuit";
          if (canFailover && await handleFailure(reason, false, true) === "failover") continue;
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
          // 连接层错误（RST、拒绝连接、socket 挂断）几乎都是瞬时的，值得原地重试；
          // 但 headers 超时不重试——它已经白等了一个完整的超时窗口，重试只会让用户再等一遍，
          // 连续超时另有 MAX_CONSECUTIVE_HEADERS_TIMEOUTS 短路兜底。
          if (canFailover) {
            const outcome = await handleFailure(reason, !headersTimedOut, true);
            if (outcome === "retry" || outcome === "failover") continue;
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
            const chatStatus = effectiveResponseStatus(chatResponse.status, chatText);
            if (shouldFailoverResponse(chatResponse.status, chatText) && canFailover) {
              const decision = await handleFailure(`http_${chatStatus}`, isRetryableStatus(chatStatus), true);
              if (decision === "retry" || decision === "failover") continue;
            }
            await sendBufferedUsageResponse(res, chatResponse, chatText, route, requestModel, input, records, metrics);
            activeRouteIndex = routeIndex;
            const success = chatResponse.status >= 200 && chatResponse.status < 400;
            if (success || !failureRecorded) await input.onRouteResult?.(route, success, `http_${chatResponse.status}`);
            finalizeMetrics(success, chatResponse.status);
            return;
          }

          const nativeStatus = effectiveResponseStatus(outcome.status, nativeBody);
          if (shouldFailoverResponse(outcome.status, nativeBody) && canFailover) {
            const decision = await handleFailure(`http_${nativeStatus}`, isRetryableStatus(nativeStatus), true);
            if (decision === "retry" || decision === "failover") continue;
          }
          await sendBufferedUsageResponse(res, {
            status: outcome.status,
            statusText: upstreamResponse.statusText,
            contentType: outcome.contentType || "application/json; charset=utf-8",
            body: Buffer.from(nativeBody)
          }, nativeBody, route, requestModel, input, records, metrics);
          activeRouteIndex = routeIndex;
          const success = outcome.status >= 200 && outcome.status < 400;
          if (success || !failureRecorded) await input.onRouteResult?.(route, success, `http_${outcome.status}`);
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
            // 还没产生有效输出时流中断是瞬时故障，可以原地重试；一旦已经输出过就不能静默重放，
            // 只能请用户重发，因此这里明确禁止重试。
            if (!streamed.outputStarted && canFailover) {
              const decision = await handleFailure(reason, true, true);
              if (decision === "retry" || decision === "failover") continue;
            }
            if (canFailover && !failureRecorded) await input.onRouteResult?.(route, false, reason);
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
        const effectiveStatus = effectiveResponseStatus(upstreamResponse.status, responseText);
        if (shouldFailoverResponse(upstreamResponse.status, responseText) && canFailover) {
          const decision = await handleFailure(`http_${effectiveStatus}`, isRetryableStatus(effectiveStatus), true);
          if (decision === "retry" || decision === "failover") continue;
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
        // 辅助端点缺失不代表 Provider 不健康，不能把它的 404 计入连续失败与健康分。
        if ((modelInvocation || upstreamResponse.ok) && (upstreamResponse.ok || !failureRecorded)) {
          await input.onRouteResult?.(route, upstreamResponse.ok, `http_${upstreamResponse.status}`);
        }
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
      void closeDispatchers();
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
      await Promise.all([closeServer, closeDispatchers()]);
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

// 会真正产生补全的模型端点。除此之外的辅助端点（Anthropic 的 count_tokens、各类能力探测）
// 在中转站上常常未实现，其 404 属于端点缺失而非 Provider 故障。
const MODEL_INVOCATION_PATHS = new Set([
  "/messages",
  "/chat/completions",
  "/completions",
  "/responses",
  "/embeddings",
  "/images/generations"
]);

export function isModelInvocationRequest(method: string | undefined, incomingUrl: string): boolean {
  if (method !== "POST") return false;
  const pathname = new URL(incomingUrl, "http://127.0.0.1").pathname.replace(/\/+$/, "");
  const withoutVersion = pathname.replace(/^\/v\d+(?=\/|$)/i, "");
  return MODEL_INVOCATION_PATHS.has(withoutVersion.toLowerCase());
}

// 值得在同一个 Provider 上原地重试的状态：限流与上游抖动。401/403/404 是确定性拒绝
// （鉴权、分组权限、端点/模型不存在），重试只会把同一个错误再拿一遍，直接换 Provider 更快。
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeNonNegativeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
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
