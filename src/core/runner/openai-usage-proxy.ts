import http, { type IncomingHttpHeaders } from "node:http";
import { appendUsageEvent } from "../config/usage-store.js";
import { writeLog } from "../logs/log-service.js";
import { extractTokenUsage } from "../models/model-discovery.js";
import type { Provider, RunToolType, TokenUsage } from "../types.js";
import { estimateTokenCostUsdFromConfig } from "../usage/pricing.js";
import { buildUsageEvent } from "../usage/usage-service.js";
import { getToolBaseUrl } from "./tool-runner.js";

export type OpenAiUsageProxyRecord = {
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd?: number;
  costSource: "provider" | "pricing" | "unknown";
};

export type OpenAiUsageProxy = {
  baseUrl: string;
  close(): Promise<void>;
  getRecords(): OpenAiUsageProxyRecord[];
};

export type StartOpenAiUsageProxyInput = {
  provider: Provider;
  model: string;
  tool: RunToolType;
  onUsage?: (record: OpenAiUsageProxyRecord) => void | Promise<void>;
};

const MAX_USAGE_CAPTURE_BYTES = 8 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const RESPONSE_HEADERS_TO_DROP = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length"
]);

export async function startOpenAiUsageProxy(input: StartOpenAiUsageProxyInput): Promise<OpenAiUsageProxy> {
  const upstreamBaseUrl = getToolBaseUrl("codex", input.provider);
  const records: OpenAiUsageProxyRecord[] = [];

  const server = http.createServer(async (req, res) => {
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
          res
        });
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
          res
        });
        return;
      }

      writeResponseHead(res, upstreamResponse);
      const captured = await streamResponse(upstreamResponse, res);
      await recordUsageFromResponse({
        text: captured.toString("utf8"),
        contentType: upstreamResponse.headers.get("content-type") ?? "",
        fallbackModel: requestModel,
        provider: input.provider.name,
        tool: input.tool,
        records,
        onUsage: input.onUsage
      });
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 502;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { message: `AI Gateway proxy failed: ${message}` } }));
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
    }
  };
}

type ResponsesChatFallbackInput = {
  upstreamBaseUrl: string;
  requestBody: Buffer;
  apiKey: string;
};

type ResponsesChatFallbackResult = {
  status: number;
  statusText: string;
  contentType: string;
  body: Buffer;
};

type SendChatCompletionsResponsesSseInput = ResponsesChatFallbackInput & {
  requestModel: string;
  provider: string;
  tool: RunToolType;
  records: OpenAiUsageProxyRecord[];
  onUsage?: (record: OpenAiUsageProxyRecord) => void | Promise<void>;
  res: http.ServerResponse;
};

function shouldTranslateResponsesStreamToChat(incomingUrl: string, requestBody: Buffer): boolean {
  const local = new URL(incomingUrl, "http://127.0.0.1");
  if (local.pathname !== "/responses" && local.pathname !== "/v1/responses") return false;
  const body = parseJsonObject(requestBody);
  return body?.stream === true;
}

function shouldFallbackResponsesToChat(incomingUrl: string, requestBody: Buffer, response: Response): boolean {
  if (response.ok) return false;
  return shouldTranslateResponsesStreamToChat(incomingUrl, requestBody);
}

async function sendChatCompletionsResponsesSse(input: SendChatCompletionsResponsesSseInput): Promise<void> {
  const fallbackResponse = await buildChatCompletionsResponsesSse({
    upstreamBaseUrl: input.upstreamBaseUrl,
    requestBody: input.requestBody,
    apiKey: input.apiKey
  });
  input.res.statusCode = fallbackResponse.status;
  input.res.statusMessage = fallbackResponse.statusText;
  input.res.setHeader("content-type", fallbackResponse.contentType);
  await recordUsageFromResponse({
    text: fallbackResponse.body.toString("utf8"),
    contentType: fallbackResponse.contentType,
    fallbackModel: input.requestModel,
    provider: input.provider,
    tool: input.tool,
    records: input.records,
    onUsage: input.onUsage
  });
  input.res.end(fallbackResponse.body);
}

async function buildChatCompletionsResponsesSse(input: ResponsesChatFallbackInput): Promise<ResponsesChatFallbackResult> {
  const responsesRequest = parseJsonObject(input.requestBody);
  if (!responsesRequest) {
    return {
      status: 400,
      statusText: "Bad Request",
      contentType: "application/json; charset=utf-8",
      body: Buffer.from(JSON.stringify({ error: { message: "Invalid Responses request body." } }))
    };
  }

  const chatResponse = await fetch(buildChatCompletionsUrl(input.upstreamBaseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(buildChatCompletionsRequest(responsesRequest))
  });

  const text = await chatResponse.text();
  if (!chatResponse.ok) {
    return {
      status: chatResponse.status,
      statusText: chatResponse.statusText,
      contentType: chatResponse.headers.get("content-type") ?? "application/json; charset=utf-8",
      body: Buffer.from(text)
    };
  }

  const chatJson = parseJsonTextObject(text);
  if (!chatJson) {
    return {
      status: 502,
      statusText: "Bad Gateway",
      contentType: "application/json; charset=utf-8",
      body: Buffer.from(JSON.stringify({ error: { message: "Chat completions fallback returned invalid JSON." } }))
    };
  }

  return {
    status: 200,
    statusText: "OK",
    contentType: "text/event-stream; charset=utf-8",
    body: Buffer.from(buildResponsesSseFromChatCompletion(chatJson, responsesRequest))
  };
}

type JsonObject = Record<string, unknown>;

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
};

type ChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

function buildChatCompletionsUrl(upstreamBaseUrl: string): string {
  return `${upstreamBaseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function buildChatCompletionsRequest(responsesRequest: JsonObject): JsonObject {
  const request: JsonObject = {
    model: typeof responsesRequest.model === "string" ? responsesRequest.model : undefined,
    messages: buildChatMessages(responsesRequest),
    stream: false
  };

  const tools = buildChatTools(responsesRequest.tools);
  if (tools.length) request.tools = tools;

  const toolChoice = buildChatToolChoice(responsesRequest.tool_choice);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;

  for (const [sourceKey, targetKey] of [
    ["parallel_tool_calls", "parallel_tool_calls"],
    ["max_output_tokens", "max_tokens"],
    ["temperature", "temperature"],
    ["top_p", "top_p"]
  ] as const) {
    const value = responsesRequest[sourceKey];
    if (value !== undefined && value !== null) request[targetKey] = value;
  }

  return request;
}

function buildChatMessages(responsesRequest: JsonObject): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (typeof responsesRequest.instructions === "string" && responsesRequest.instructions.trim()) {
    messages.push({ role: "system", content: responsesRequest.instructions.trim() });
  }

  const input = responsesRequest.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const message = responsesItemToChatMessage(item);
      if (message) messages.push(message);
    }
  }

  if (!messages.length) {
    messages.push({ role: "user", content: "" });
  }
  return messages;
}

function responsesItemToChatMessage(item: unknown): ChatMessage | null {
  if (!isPlainObject(item)) return null;
  const type = typeof item.type === "string" ? item.type : "";

  if (type === "function_call") {
    const name = typeof item.name === "string" ? item.name : "";
    if (!name) return null;
    return {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${Date.now()}`,
        type: "function",
        function: {
          name,
          arguments: stringifyToolArguments(item.arguments)
        }
      }]
    };
  }

  if (type === "function_call_output") {
    return {
      role: "tool",
      tool_call_id: typeof item.call_id === "string" ? item.call_id : "",
      content: contentToText(item.output)
    };
  }

  const role = normalizeChatRole(item.role);
  if (!role) return null;
  const content = contentToText(item.content);
  if (!content && role !== "system") return null;
  return { role, content };
}

function normalizeChatRole(value: unknown): ChatMessage["role"] | null {
  if (value === "developer" || value === "system") return "system";
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  if (value === "tool") return "tool";
  return null;
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (isPlainObject(item)) {
          for (const key of ["text", "output_text", "input_text", "content", "output"]) {
            const nested = item[key];
            if (typeof nested === "string") return nested;
          }
        }
        return "";
      })
      .filter((item) => item.trim())
      .join("\n\n");
  }
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function stringifyToolArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

function buildChatTools(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  const tools: JsonObject[] = [];
  for (const tool of value) {
    if (!isPlainObject(tool) || tool.type !== "function") continue;
    const functionSpec = isPlainObject(tool.function) ? tool.function : tool;
    const name = typeof functionSpec.name === "string" ? functionSpec.name : "";
    if (!name) continue;
    const next: JsonObject = {
      type: "function",
      function: {
        name,
        description: typeof functionSpec.description === "string" ? functionSpec.description : "",
        parameters: isPlainObject(functionSpec.parameters) ? functionSpec.parameters : { type: "object", properties: {} }
      }
    };
    const strict = functionSpec.strict ?? tool.strict;
    if (typeof strict === "boolean" && isPlainObject(next.function)) {
      next.function.strict = strict;
    }
    tools.push(next);
  }
  return tools;
}

function buildChatToolChoice(value: unknown): unknown {
  if (value === "auto" || value === "none" || value === "required") return value;
  if (!isPlainObject(value)) return undefined;
  if (value.type === "function" && typeof value.name === "string") {
    return { type: "function", function: { name: value.name } };
  }
  if (isPlainObject(value.function) && typeof value.function.name === "string") {
    return { type: "function", function: { name: value.function.name } };
  }
  return undefined;
}

function buildResponsesSseFromChatCompletion(chatCompletion: JsonObject, responsesRequest: JsonObject): string {
  const model = typeof chatCompletion.model === "string"
    ? chatCompletion.model
    : typeof responsesRequest.model === "string"
      ? responsesRequest.model
      : "unknown";
  const responseId = typeof chatCompletion.id === "string" ? chatCompletion.id.replace(/^chatcmpl-/, "resp_") : `resp_${Date.now()}`;
  const outputItems = buildResponsesOutputItems(chatCompletion);
  const startedResponse = buildResponsesResponse({
    id: responseId,
    model,
    status: "in_progress",
    output: [],
    usage: null
  });
  const completedResponse = buildResponsesResponse({
    id: responseId,
    model,
    status: "completed",
    output: outputItems,
    usage: convertChatUsage(chatCompletion.usage)
  });
  const chunks = [
    writeSse("response.created", { type: "response.created", response: startedResponse }),
    writeSse("response.in_progress", { type: "response.in_progress", response: startedResponse })
  ];

  outputItems.forEach((item, index) => {
    if (item.type === "message") {
      chunks.push(...buildMessageSseChunks(item, index));
    } else if (item.type === "function_call") {
      chunks.push(...buildFunctionCallSseChunks(item, index));
    }
  });

  chunks.push(writeSse("response.completed", { type: "response.completed", response: completedResponse }));
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

function buildResponsesOutputItems(chatCompletion: JsonObject): JsonObject[] {
  const choices = Array.isArray(chatCompletion.choices) ? chatCompletion.choices : [];
  const firstChoice = choices.find(isPlainObject);
  const message = isPlainObject(firstChoice?.message) ? firstChoice.message : {};
  const output: JsonObject[] = [];
  const content = typeof message.content === "string" ? message.content : "";
  if (content) {
    output.push({
      id: `msg_${Date.now()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }]
    });
  }

  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((toolCall, index) => {
      if (!isPlainObject(toolCall) || !isPlainObject(toolCall.function)) return;
      const name = typeof toolCall.function.name === "string" ? toolCall.function.name : "";
      if (!name) return;
      output.push({
        id: `fc_${Date.now()}_${index}`,
        type: "function_call",
        status: "completed",
        call_id: typeof toolCall.id === "string" ? toolCall.id : `call_${Date.now()}_${index}`,
        name,
        arguments: stringifyToolArguments(toolCall.function.arguments)
      });
    });
  }

  return output;
}

function buildResponsesResponse(input: {
  id: string;
  model: string;
  status: "in_progress" | "completed";
  output: JsonObject[];
  usage: JsonObject | null;
}): JsonObject {
  return {
    id: input.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: input.status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: input.model,
    output: input.output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: input.usage
  };
}

function buildMessageSseChunks(item: JsonObject, outputIndex: number): string[] {
  const content = Array.isArray(item.content) ? item.content : [];
  const firstPart = content.find(isPlainObject) ?? { type: "output_text", text: "", annotations: [] };
  const text = typeof firstPart.text === "string" ? firstPart.text : "";
  const itemId = typeof item.id === "string" ? item.id : `msg_${Date.now()}`;
  const inProgressItem = { ...item, id: itemId, status: "in_progress", content: [] };
  return [
    writeSse("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item: inProgressItem }),
    writeSse("response.content_part.added", {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    }),
    writeSse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      delta: text
    }),
    writeSse("response.output_text.done", {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text
    }),
    writeSse("response.content_part.done", {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: firstPart
    }),
    writeSse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item })
  ];
}

function buildFunctionCallSseChunks(item: JsonObject, outputIndex: number): string[] {
  const itemId = typeof item.id === "string" ? item.id : `fc_${Date.now()}`;
  const args = typeof item.arguments === "string" ? item.arguments : "{}";
  return [
    writeSse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, id: itemId, status: "in_progress", arguments: "" }
    }),
    writeSse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: outputIndex,
      delta: args
    }),
    writeSse("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: outputIndex,
      arguments: args
    }),
    writeSse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item })
  ];
}

function convertChatUsage(value: unknown): JsonObject | null {
  if (!isPlainObject(value)) return null;
  const inputTokens = readNumber(value.prompt_tokens) ?? readNumber(value.input_tokens) ?? 0;
  const outputTokens = readNumber(value.completion_tokens) ?? readNumber(value.output_tokens) ?? 0;
  const totalTokens = readNumber(value.total_tokens) ?? inputTokens + outputTokens;
  const promptDetails = isPlainObject(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const inputDetails = isPlainObject(value.input_tokens_details) ? value.input_tokens_details : {};
  const cachedTokens = readNumber(promptDetails.cached_tokens) ?? readNumber(inputDetails.cached_tokens) ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: { cached_tokens: cachedTokens }
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function writeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseJsonObject(body: Buffer): JsonObject | null {
  const text = body.toString("utf8").trim();
  if (!text || !text.startsWith("{")) return null;
  return parseJsonTextObject(text);
}

function parseJsonTextObject(text: string): JsonObject | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildUpstreamUrl(upstreamBaseUrl: string, incomingUrl: string): string {
  const local = new URL(incomingUrl, "http://127.0.0.1");
  let suffix = local.pathname;
  if (suffix === "/v1") {
    suffix = "";
  } else if (suffix.startsWith("/v1/")) {
    suffix = suffix.slice(3);
  }
  const upstream = new URL(`${upstreamBaseUrl.replace(/\/+$/, "")}${suffix}`);
  upstream.search = local.search;
  return upstream.toString();
}

function buildUpstreamHeaders(headers: IncomingHttpHeaders, apiKey: string, body: Buffer): Headers {
  const next = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === "host" || normalized === "content-length") continue;
    if (Array.isArray(value)) {
      next.set(key, value.join(", "));
    } else if (typeof value === "string") {
      next.set(key, value);
    }
  }
  next.set("authorization", `Bearer ${apiKey}`);
  next.set("accept-encoding", "identity");
  if (body.length) next.set("content-length", String(body.length));
  return next;
}

function writeResponseHead(res: http.ServerResponse, response: Response): void {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  for (const [key, value] of response.headers.entries()) {
    if (!RESPONSE_HEADERS_TO_DROP.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  }
}

async function streamResponse(response: Response, res: http.ServerResponse): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  if (!response.body) return Buffer.alloc(0);

  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    if (capturedBytes < MAX_USAGE_CAPTURE_BYTES) {
      const remaining = MAX_USAGE_CAPTURE_BYTES - capturedBytes;
      chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
      capturedBytes += Math.min(buffer.length, remaining);
    }
    res.write(buffer);
  }

  return Buffer.concat(chunks);
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function recordUsageFromResponse(input: {
  text: string;
  contentType: string;
  fallbackModel: string;
  provider: string;
  tool: RunToolType;
  records: OpenAiUsageProxyRecord[];
  onUsage?: (record: OpenAiUsageProxyRecord) => void | Promise<void>;
}): Promise<void> {
  const candidate = extractBestUsageCandidate(input.text, input.contentType, input.fallbackModel);
  if (!candidate) {
    await writeLog({
      category: "usage",
      action: "openai_usage_proxy_no_usage",
      message: `Provider response did not include usage for ${input.provider} / ${input.fallbackModel}.`,
      metadata: {
        tool: input.tool,
        provider: input.provider,
        model: input.fallbackModel,
        contentType: input.contentType
      }
    });
    return;
  }

  const pricedCost = candidate.costUsd ?? await estimateTokenCostUsdFromConfig(input.provider, candidate.model, candidate.usage);
  const record: OpenAiUsageProxyRecord = {
    provider: input.provider,
    model: candidate.model,
    usage: candidate.usage,
    costUsd: pricedCost,
    costSource: candidate.costUsd !== undefined ? "provider" : pricedCost !== undefined ? "pricing" : "unknown"
  };
  input.records.push(record);

  await appendUsageEvent(buildUsageEvent({
    provider: input.provider,
    tool: input.tool,
    model: record.model,
    source: "proxy",
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    totalTokens: record.usage.totalTokens,
    cacheReadInputTokens: record.usage.cacheReadInputTokens
  })).catch(() => undefined);
  await writeLog({
    category: "usage",
    action: "openai_usage_proxy_recorded",
    message: `Recorded proxied usage for ${record.provider} / ${record.model}.`,
    metadata: {
      tool: input.tool,
      provider: record.provider,
      model: record.model,
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      totalTokens: record.usage.totalTokens,
      cacheReadInputTokens: record.usage.cacheReadInputTokens,
      costUsd: record.costUsd,
      costSource: record.costSource
    }
  });
  await Promise.resolve(input.onUsage?.(record)).catch(() => undefined);
}

type UsageCandidate = {
  model: string;
  usage: TokenUsage;
  costUsd?: number;
};

function extractBestUsageCandidate(text: string, contentType: string, fallbackModel: string): UsageCandidate | null {
  const values = contentType.includes("text/event-stream") ? parseSseValues(text) : parseJsonValues(text);
  let best: UsageCandidate | null = null;

  for (const value of values) {
    for (const candidate of collectUsageCandidates(value, fallbackModel)) {
      if (!best || candidate.usage.totalTokens >= best.usage.totalTokens) {
        best = candidate;
      }
    }
  }

  return best;
}

function parseJsonValues(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return [];
  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    return [];
  }
}

function parseSseValues(text: string): unknown[] {
  const values: unknown[] = [];
  let data = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      pushSseData(values, data);
      data = "";
      continue;
    }
    if (line.startsWith("data:")) {
      data += `${line.slice(5).trimStart()}\n`;
    }
  }
  pushSseData(values, data);
  return values;
}

function pushSseData(values: unknown[], data: string): void {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return;
  try {
    values.push(JSON.parse(trimmed) as unknown);
  } catch {
    // Ignore non-JSON SSE frames.
  }
}

function collectUsageCandidates(value: unknown, fallbackModel: string, depth = 0): UsageCandidate[] {
  if (depth > 6 || !value || typeof value !== "object") return [];

  const candidates: UsageCandidate[] = [];
  const usage = extractTokenUsage(value);
  if (usage) {
    candidates.push({
      model: extractModel(value) ?? fallbackModel,
      usage,
      costUsd: extractCostUsd(value)
    });
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      candidates.push(...collectUsageCandidates(item, fallbackModel, depth + 1));
    }
    return candidates;
  }

  const record = value as Record<string, unknown>;
  for (const nested of Object.values(record)) {
    candidates.push(...collectUsageCandidates(nested, extractModel(record) ?? fallbackModel, depth + 1));
  }
  return candidates;
}

function extractRequestModel(body: Buffer): string | undefined {
  const text = body.toString("utf8").trim();
  if (!text || !text.startsWith("{")) return undefined;
  try {
    return extractModel(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function extractModel(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const model = (value as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

function extractCostUsd(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["total_cost_usd", "cost_usd", "costUsd", "totalCostUsd", "total_cost", "cost"]) {
    const cost = readCostValue(record[key]);
    if (cost !== undefined) return cost;
  }
  return undefined;
}

function readCostValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().replace(/^\$/, "");
    const numeric = Number(normalized);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return undefined;
}

function methodMayHaveBody(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}
