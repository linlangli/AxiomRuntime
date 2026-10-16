import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fetch, type Dispatcher, type Response } from "undici";
import {
  readCache,
  recordProviderRuntimeFailure,
  recordProviderRuntimeSuccess
} from "../core/config/cache-store.js";
import { loadRuntimeConfig } from "../core/config/runtime-config.js";
import { loadServiceExposure, authorizeServiceCredential, SERVICE_CAPABILITIES } from "../core/config/service-exposure.js";
import { readProviders } from "../core/config/providers-store.js";
import { writeLog } from "../core/logs/log-service.js";
import {
  createUpstreamDispatcher,
  resolveProviderProxy
} from "../core/network/proxy.js";
import { getProviderAuthScheme } from "../core/providers/provider-request-profile.js";
import { resolveProviderCandidatesForTool, type ResolvedRun } from "../core/runner/fallback.js";
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  methodMayHaveBody,
  streamResponse,
  writeResponseHead
} from "../core/runner/openai-usage-http.js";
import { recordUsageFromResponse } from "../core/runner/openai-usage-recording.js";
import {
  buildChatCompletionsResponsesSse,
  isResponsesStreamRequest,
  shouldFallbackResponsesToChat
} from "../core/runner/openai-usage-responses.js";
import type { OpenAiUsageProxyRecord } from "../core/runner/openai-usage-types.js";
import { getToolBaseUrl } from "../core/runner/tool-runner.js";
import { createTelegramEngine } from "../telegram/engine/registry.js";
import type { ExecutionResult } from "../telegram/engine/types.js";

const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_HEADERS_TIMEOUT_MS = 45_000;
const ALLOWED_PROXY_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/embeddings"
]);

export type RuntimeServerOptions = {
  host?: string;
  port?: number;
  token?: string;
  useExposureConfig?: boolean;
  maxRequestBytes?: number;
  upstreamHeadersTimeoutMs?: number;
  agentWorkspaceRoot?: string;
  agentMaxConcurrentRuns?: number;
  agentTimeoutMs?: number;
};

export type RuntimeServer = {
  baseUrl: string;
  close(): Promise<void>;
};

export async function startRuntimeServer(options: RuntimeServerOptions): Promise<RuntimeServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8080;
  const token = options.token?.trim() ?? "";
  if (!token && (!options.useExposureConfig || !(await loadServiceExposure()).credentials.length)) throw new Error("AI Gateway server requires a token or configured service credentials.");

  const headersTimeoutMs = normalizePositiveInteger(options.upstreamHeadersTimeoutMs, DEFAULT_HEADERS_TIMEOUT_MS);
  // 按代理 URL 分派：Provider 级 proxyUrl 覆盖 runtime.json 全局默认（启动时读一次），
  // 逐候选用同一 URL 的共享连接池，close() 统一关闭。
  const globalProxyUrl = (await loadRuntimeConfig()).proxyUrl ?? null;
  const dispatchersByUrl = new Map<string, Dispatcher>();
  const dispatcherFor = (proxyUrl: string | null): Dispatcher => {
    const key = proxyUrl ?? "";
    let dispatcher = dispatchersByUrl.get(key);
    if (!dispatcher) {
      dispatcher = createUpstreamDispatcher(proxyUrl, { connections: 32, headersTimeout: headersTimeoutMs });
      dispatchersByUrl.set(key, dispatcher);
    }
    return dispatcher;
  };
  const closeDispatchers = (): Promise<void[]> =>
    Promise.all([...dispatchersByUrl.values()].map((dispatcher) => dispatcher.close().catch(() => undefined)));
  const maxRequestBytes = normalizePositiveInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES);
  const agentRuntime = {
    workspaceRoot: path.resolve(options.agentWorkspaceRoot ?? path.join(process.cwd(), ".ai-gateway-workspaces")),
    maxConcurrentRuns: normalizePositiveInteger(options.agentMaxConcurrentRuns, 2),
    timeoutMs: normalizePositiveInteger(options.agentTimeoutMs, 10 * 60 * 1000),
    activeRuns: 0
  };
  await fs.mkdir(agentRuntime.workspaceRoot, { recursive: true });
  const server = http.createServer(async (req, res) => {
    const requestId = normalizeRequestId(req.headers["x-request-id"]);
    res.setHeader("x-request-id", requestId);
    try {
      await handleRequest({ req, res, requestId, token, useExposureConfig: options.useExposureConfig === true, maxRequestBytes, globalProxyUrl, dispatcherFor, agentRuntime });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError && !res.headersSent) {
        sendJson(res, 413, { error: { message: error.message, request_id: requestId } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await writeLog({
        level: "error",
        category: "error",
        action: "runtime_server_request_failed",
        message: `Runtime server request failed: ${message}`,
        metadata: { requestId, path: req.url ?? "/" }
      });
      if (!res.headersSent) sendJson(res, 500, { error: { message: "Internal AI Gateway error.", request_id: requestId } });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind AI Gateway runtime server.");

  return {
    baseUrl: `http://${displayHost(host)}:${address.port}`,
    async close() {
      const closeServer = server.listening
        ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve();
      await Promise.all([closeServer, closeDispatchers()]);
    }
  };
}

async function handleRequest(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestId: string;
  token: string;
  useExposureConfig: boolean;
  maxRequestBytes: number;
  globalProxyUrl: string | null;
  dispatcherFor: (proxyUrl: string | null) => Dispatcher;
  agentRuntime: AgentRuntimeState;
}): Promise<void> {
  const { req, res, requestId } = input;
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (req.method === "GET" && path === "/health/live") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (req.method === "GET" && path === "/health/ready") {
    const providers = await readProviders();
    sendJson(res, providers.length ? 200 : 503, {
      status: providers.length ? "ready" : "not_ready",
      providers: providers.length
    });
    return;
  }
  const exposure = input.useExposureConfig ? await loadServiceExposure() : null;
  const credentialCapabilities = exposure ? authorizeServiceCredential(exposure, req.headers.authorization?.replace(/^Bearer /, "") ?? "") : null;
  const adminAuthorized = Boolean(input.token) && isAuthorized(req.headers.authorization, input.token);
  if (!adminAuthorized && !credentialCapabilities) {
    res.setHeader("www-authenticate", "Bearer");
    sendJson(res, 401, { error: { message: "Unauthorized.", request_id: requestId } });
    return;
  }
  if (exposure) {
    const capability = SERVICE_CAPABILITIES.find(item => item.method === req.method && item.path === path);
    if (!capability || !exposure.capabilities.includes(capability.id) || (!adminAuthorized && !credentialCapabilities?.includes(capability.id))) {
      await writeLog({ level: "warn", category: "provider", action: "runtime_service_access_denied", message: "Service capability denied.", traceId: requestId, metadata: { requestId, capability: capability?.id ?? "unknown" } });
      sendJson(res, 403, { error: { message: "Capability is not authorized.", request_id: requestId } });
      return;
    }
  }
  if (req.method === "GET" && path === "/v1/models") {
    await sendModels(res);
    return;
  }
  if (req.method === "POST" && path === "/v1/agent/runs") {
    const requestBody = await readBoundedRequestBody(req, input.maxRequestBytes);
    await runAgent(input.res, requestBody, requestId, input.agentRuntime);
    return;
  }
  if (req.method !== "POST" || !ALLOWED_PROXY_PATHS.has(path)) {
    sendJson(res, 404, { error: { message: "Route not found.", request_id: requestId } });
    return;
  }

  const requestBody = await readBoundedRequestBody(req, input.maxRequestBytes);
  const requestedModel = extractModel(requestBody);
  if (!requestedModel) {
    sendJson(res, 400, { error: { message: "Request body must include model.", request_id: requestId } });
    return;
  }
  // 解析阶段的跳过日志与后续每一跳共享 requestId，链路视图才能看到"熔断跳过"这些前置跳。
  const candidates = await resolveProviderCandidatesForTool("codex", undefined, requestedModel, requestId);
  if (!candidates.length) {
    sendJson(res, 503, { error: { message: `No healthy provider offers model ${requestedModel}.`, request_id: requestId } });
    return;
  }
  await proxyWithFallback({
    req: input.req,
    res: input.res,
    requestId,
    requestBody,
    requestedModel,
    candidates,
    globalProxyUrl: input.globalProxyUrl,
    dispatcherFor: input.dispatcherFor
  });
}

type AgentRuntimeState = {
  workspaceRoot: string;
  maxConcurrentRuns: number;
  timeoutMs: number;
  activeRuns: number;
};

type AgentRunRequest = {
  engine: "claude" | "codex";
  prompt: string;
  workspaceId: string;
  permissionMode: "read_only" | "workspace_write";
  providerName?: string;
  modelName?: string;
};

async function runAgent(
  res: http.ServerResponse,
  body: Buffer,
  requestId: string,
  runtime: AgentRuntimeState
): Promise<void> {
  const request = parseAgentRunRequest(body);
  if (!request) {
    sendJson(res, 400, {
      error: {
        message: "Agent run requires engine, prompt, and a safe workspace_id.",
        request_id: requestId
      }
    });
    return;
  }
  if (runtime.activeRuns >= runtime.maxConcurrentRuns) {
    res.setHeader("retry-after", "5");
    sendJson(res, 429, { error: { message: "Agent run concurrency limit reached.", request_id: requestId } });
    return;
  }

  const cwd = path.join(runtime.workspaceRoot, request.workspaceId);
  await fs.mkdir(cwd, { recursive: true });
  const engine = createTelegramEngine(request.engine);
  const runId = stableRunId(requestId);
  runtime.activeRuns += 1;
  try {
    const result = await engine.execute({
      chatId: runId,
      prompt: request.prompt,
      cwd,
      permissionMode: request.permissionMode === "workspace_write" ? "acceptEdits" : "readOnly",
      providerName: request.providerName,
      modelName: request.modelName,
      timeoutMs: runtime.timeoutMs,
      onPermission: async () => false
    });
    sendJson(res, 200, serializeAgentResult(requestId, request, result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: { message, request_id: requestId } });
  } finally {
    runtime.activeRuns -= 1;
  }
}

function parseAgentRunRequest(body: Buffer): AgentRunRequest | null {
  try {
    const value = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    const engine = value.engine;
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    const workspaceId = typeof value.workspace_id === "string" ? value.workspace_id.trim() : "";
    const permissionMode = value.permission_mode === "workspace_write" ? "workspace_write" : "read_only";
    if ((engine !== "claude" && engine !== "codex") || !prompt || prompt.length > 200_000) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspaceId)) return null;
    return {
      engine,
      prompt,
      workspaceId,
      permissionMode,
      ...(typeof value.provider === "string" && value.provider.trim() ? { providerName: value.provider.trim() } : {}),
      ...(typeof value.model === "string" && value.model.trim() ? { modelName: value.model.trim() } : {})
    };
  } catch {
    return null;
  }
}

function serializeAgentResult(
  requestId: string,
  request: AgentRunRequest,
  result: ExecutionResult
): Record<string, unknown> {
  return {
    id: requestId,
    object: "agent.run",
    engine: request.engine,
    workspace_id: request.workspaceId,
    response: result.response,
    session_id: result.sessionId ?? null,
    provider: result.provider ?? null,
    model: result.model ?? null,
    usage: result.usage ?? null,
    cost_usd: result.cost ?? null,
    duration_ms: result.duration ?? null,
    files_changed: result.filesChanged ?? [],
    tool_calls: result.toolCalls ?? []
  };
}

function stableRunId(requestId: string): number {
  const digest = crypto.createHash("sha256").update(requestId).digest();
  return digest.readUInt32BE(0) || 1;
}

async function proxyWithFallback(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestId: string;
  requestBody: Buffer;
  requestedModel: string;
  candidates: ResolvedRun[];
  globalProxyUrl: string | null;
  dispatcherFor: (proxyUrl: string | null) => Dispatcher;
}): Promise<void> {
  const records: OpenAiUsageProxyRecord[] = [];
  let lastFailure: BufferedUpstream | null = null;

  for (const [index, candidate] of input.candidates.entries()) {
    const upstreamBaseUrl = getToolBaseUrl("codex", candidate.provider);
    const upstreamUrl = buildUpstreamUrl(upstreamBaseUrl, input.req.url ?? "/");
    const dispatcher = input.dispatcherFor(resolveProviderProxy(candidate.provider, input.globalProxyUrl));
    try {
      const response = await fetch(upstreamUrl, {
        method: input.req.method,
        headers: buildUpstreamHeaders(input.req.headers, candidate.provider.apiKey, {
          authScheme: getProviderAuthScheme(candidate.provider, "openai")
        }),
        body: input.requestBody.length && methodMayHaveBody(input.req.method) ? input.requestBody : undefined,
        dispatcher
      });
      const responsesStream = isResponsesStreamRequest(input.req.url ?? "/", input.requestBody);
      if (responsesStream && !isUsableEventStream(response)) {
        const nativeFailure = await bufferUpstream(response);
        if (shouldFallbackResponsesToChat({
          status: nativeFailure.status,
          contentType: nativeFailure.contentType,
          bodyText: nativeFailure.body.toString("utf8")
        })) {
          const translated = await buildChatCompletionsResponsesSse({
            upstreamBaseUrl,
            requestBody: input.requestBody,
            apiKey: candidate.provider.apiKey,
            authScheme: getProviderAuthScheme(candidate.provider, "openai"),
            dispatcher
          });
          const fallbackResponse: BufferedUpstream = {
            status: translated.status,
            statusText: translated.statusText,
            contentType: translated.contentType,
            body: translated.body
          };
          if (isRetryableStatus(fallbackResponse.status) && index < input.candidates.length - 1) {
            await recordCandidateFailure(candidate, fallbackResponse, input.requestId, index + 1, input.candidates.length);
            lastFailure = fallbackResponse;
            continue;
          }
          await sendBufferedResult(input.res, candidate, fallbackResponse, records, input.requestedModel);
          await logRequestSettled(candidate, input.requestId, index + 1, input.candidates.length, fallbackResponse.status);
          return;
        }
        if (isRetryableStatus(nativeFailure.status) && index < input.candidates.length - 1) {
          await recordCandidateFailure(candidate, nativeFailure, input.requestId, index + 1, input.candidates.length);
          lastFailure = nativeFailure;
          continue;
        }
        await sendBufferedResult(input.res, candidate, nativeFailure, records, input.requestedModel);
        await logRequestSettled(candidate, input.requestId, index + 1, input.candidates.length, nativeFailure.status);
        return;
      }

      if (isRetryableStatus(response.status) && index < input.candidates.length - 1) {
        const failure = await bufferUpstream(response);
        await recordCandidateFailure(candidate, failure, input.requestId, index + 1, input.candidates.length);
        lastFailure = failure;
        continue;
      }

      input.res.setHeader("x-agent-router-provider", candidate.provider.name);
      writeResponseHead(input.res, response);
      const captured = await streamResponse(response, input.res);
      await recordUsageFromResponse({
        text: captured.toString("utf8"),
        contentType: response.headers.get("content-type") ?? "",
        fallbackModel: input.requestedModel,
        provider: candidate.provider.name,
        tool: "codex",
        records
      });
      if (response.ok) await recordProviderRuntimeSuccess(candidate.provider.name);
      else await recordProviderRuntimeFailure(candidate.provider.name, `HTTP ${response.status}`);
      input.res.end();
      await logRequestSettled(candidate, input.requestId, index + 1, input.candidates.length, response.status);
      return;
    } catch (error) {
      await recordProviderRuntimeFailure(candidate.provider.name, error);
      await logFallback(candidate, input.requestId, error, index + 1, input.candidates.length);
      if (index === input.candidates.length - 1) {
        sendJson(input.res, 502, {
          error: { message: "All configured AI providers failed.", request_id: input.requestId }
        });
        await logRequestExhausted(input.requestId, input.candidates, 502);
        return;
      }
    }
  }

  if (lastFailure) {
    sendBuffered(input.res, lastFailure);
    await logRequestExhausted(input.requestId, input.candidates, lastFailure.status);
    return;
  }
  sendJson(input.res, 503, { error: { message: "No usable AI provider.", request_id: input.requestId } });
  await logRequestExhausted(input.requestId, input.candidates, 503);
}

/** 记录链路的终止跳：哪个 provider 最终承接了请求、用掉了几次尝试。 */
async function logRequestSettled(
  candidate: ResolvedRun,
  requestId: string,
  attempt: number,
  totalCandidates: number,
  status: number
): Promise<void> {
  const failed = status < 200 || status >= 400;
  await writeLog({
    level: failed ? "warn" : "info",
    category: "strategy",
    action: "runtime_server_request_settled",
    message: `Request served by ${candidate.provider.name} with HTTP ${status}.`,
    traceId: requestId,
    metadata: {
      requestId,
      attempt,
      totalCandidates,
      provider: candidate.provider.name,
      level: candidate.provider.level,
      model: candidate.model,
      status,
      fellBack: attempt > 1
    }
  });
}

/** 记录所有候选都用尽的链路终止跳。 */
async function logRequestExhausted(
  requestId: string,
  candidates: ResolvedRun[],
  status: number
): Promise<void> {
  await writeLog({
    level: "error",
    category: "strategy",
    action: "runtime_server_candidates_exhausted",
    message: `All ${candidates.length} provider candidate(s) failed.`,
    traceId: requestId,
    metadata: {
      requestId,
      status,
      totalCandidates: candidates.length,
      attempted: candidates.map((candidate) => candidate.provider.name)
    }
  });
}

async function sendModels(res: http.ServerResponse): Promise<void> {
  const [providers, cache] = await Promise.all([readProviders(), readCache()]);
  const ids = new Set<string>();
  for (const provider of providers) {
    if (provider.model) ids.add(provider.model);
    for (const model of cache.providers[provider.name]?.models ?? []) ids.add(model);
  }
  sendJson(res, 200, {
    object: "list",
    data: [...ids].sort().map((id) => ({ id, object: "model", owned_by: "agent-router" }))
  });
}

async function sendBufferedResult(
  res: http.ServerResponse,
  candidate: ResolvedRun,
  result: BufferedUpstream,
  records: OpenAiUsageProxyRecord[],
  fallbackModel: string
): Promise<void> {
  res.setHeader("x-agent-router-provider", candidate.provider.name);
  await recordUsageFromResponse({
    text: result.body.toString("utf8"),
    contentType: result.contentType,
    fallbackModel,
    provider: candidate.provider.name,
    tool: "codex",
    records
  });
  if (result.status >= 200 && result.status < 400) await recordProviderRuntimeSuccess(candidate.provider.name);
  else await recordProviderRuntimeFailure(candidate.provider.name, `HTTP ${result.status}`);
  sendBuffered(res, result);
}

type BufferedUpstream = {
  status: number;
  statusText: string;
  contentType: string;
  body: Buffer;
};

async function bufferUpstream(response: Response): Promise<BufferedUpstream> {
  return {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type") ?? "application/json; charset=utf-8",
    body: Buffer.from(await response.arrayBuffer())
  };
}

function sendBuffered(res: http.ServerResponse, result: BufferedUpstream): void {
  res.statusCode = result.status;
  res.statusMessage = result.statusText;
  res.setHeader("content-type", result.contentType);
  res.setHeader("content-length", String(result.body.length));
  res.end(result.body);
}

async function recordCandidateFailure(
  candidate: ResolvedRun,
  failure: BufferedUpstream,
  requestId: string,
  attempt: number,
  totalCandidates: number
): Promise<void> {
  await recordProviderRuntimeFailure(candidate.provider.name, `HTTP ${failure.status}`);
  await logFallback(candidate, requestId, `HTTP ${failure.status}`, attempt, totalCandidates);
}

async function logFallback(
  candidate: ResolvedRun,
  requestId: string,
  error: unknown,
  attempt: number,
  totalCandidates: number
): Promise<void> {
  await writeLog({
    level: "warn",
    category: "strategy",
    action: "runtime_server_provider_fallback",
    message: `Provider ${candidate.provider.name} failed; trying the next candidate.`,
    // 复用请求自身的 id：同一次请求的每一跳共享它，调用链路视图才能聚合成一条链路。
    traceId: requestId,
    metadata: {
      requestId,
      attempt,
      totalCandidates,
      provider: candidate.provider.name,
      level: candidate.provider.level,
      model: candidate.model,
      error: error instanceof Error ? error.message : String(error)
    }
  });
}

async function readBoundedRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds configured limit.");
  }
}

function extractModel(body: Buffer): string | null {
  try {
    const value = JSON.parse(body.toString("utf8")) as { model?: unknown };
    return typeof value.model === "string" && value.model.trim() ? value.model.trim() : null;
  } catch {
    return null;
  }
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 408 || status === 409
    || status === 425 || status === 429 || status >= 500;
}

function isUsableEventStream(response: Response): boolean {
  return response.ok && (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeRequestId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.trim().slice(0, 128) || `req_${crypto.randomUUID()}`;
}

function displayHost(host: string): string {
  return host === "0.0.0.0" ? "127.0.0.1" : host;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.length));
  res.end(body);
}
