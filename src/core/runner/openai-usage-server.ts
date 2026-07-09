import http from "node:http";
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
  shouldFallbackResponsesToChat,
  shouldTranslateResponsesStreamToChat,
  type ResponsesChatFallbackInput
} from "./openai-usage-responses.js";
import { extractRequestModel, recordUsageFromResponse } from "./openai-usage-recording.js";
import type { OpenAiUsageProxy, OpenAiUsageProxyMetrics, OpenAiUsageProxyRecord, StartOpenAiUsageProxyInput } from "./openai-usage-types.js";
import { getToolBaseUrl } from "./tool-runner.js";

export async function startOpenAiUsageProxy(input: StartOpenAiUsageProxyInput): Promise<OpenAiUsageProxy> {
  const upstreamBaseUrl = getToolBaseUrl("codex", input.provider);
  const records: OpenAiUsageProxyRecord[] = [];
  const metrics = createEmptyMetrics();

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
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
      const requestModel = extractRequestModel(requestBody) ?? input.model;
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
      if (shouldTranslateResponsesStreamToChat(req.url ?? "/", requestBody)) {
        void writeLog({
          category: "usage",
          action: "openai_usage_proxy_responses_chat_translate",
          message: `Translating Responses stream for ${input.provider.name} / ${requestModel} through chat completions.`,
          metadata: {
            tool: input.tool,
            provider: input.provider.name,
            model: requestModel
          }
        });
        await sendChatCompletionsResponsesSse({
          upstreamBaseUrl,
          requestBody,
          apiKey: input.provider.apiKey,
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

      const upstreamUrl = buildUpstreamUrl(upstreamBaseUrl, req.url ?? "/");
      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers: buildUpstreamHeaders(req.headers, input.provider.apiKey, requestBody),
        body: requestBody.length && methodMayHaveBody(req.method) ? requestBody : undefined
      });

      if (shouldFallbackResponsesToChat(req.url ?? "/", requestBody, upstreamResponse)) {
        await upstreamResponse.body?.cancel().catch(() => undefined);
        void writeLog({
          category: "usage",
          action: "openai_usage_proxy_responses_chat_fallback",
          message: `Responses stream failed for ${input.provider.name} / ${requestModel}; falling back to chat completions.`,
          metadata: {
            tool: input.tool,
            provider: input.provider.name,
            model: requestModel,
            status: upstreamResponse.status
          }
        });
        await sendChatCompletionsResponsesSse({
          upstreamBaseUrl,
          requestBody,
          apiKey: input.provider.apiKey,
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

      writeResponseHead(res, upstreamResponse);
      const captured = await streamResponse(upstreamResponse, res);
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
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 502;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { message: `AI Gateway proxy failed: ${message}` } }));
      finalizeMetrics(false, "proxy_error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start AI Gateway OpenAI proxy.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
    getRecords() {
      return [...records];
    },
    getMetrics() {
      return snapshotMetrics(metrics);
    }
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

async function sendChatCompletionsResponsesSse(input: SendChatCompletionsResponsesSseInput): Promise<{ status: number }> {
  const fallbackResponse = await buildChatCompletionsResponsesSse({
    upstreamBaseUrl: input.upstreamBaseUrl,
    requestBody: input.requestBody,
    apiKey: input.apiKey
  });
  input.res.statusCode = fallbackResponse.status;
  input.res.statusMessage = fallbackResponse.statusText;
  input.res.setHeader("content-type", fallbackResponse.contentType);
  const recordedUsage = await recordUsageFromResponse({
    text: fallbackResponse.body.toString("utf8"),
    contentType: fallbackResponse.contentType,
    fallbackModel: input.requestModel,
    provider: input.provider,
    tool: input.tool,
    records: input.records,
    onUsage: input.onUsage
  });
  recordUsageMetric(input.metrics, recordedUsage);
  input.res.end(fallbackResponse.body);
  return { status: fallbackResponse.status };
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
