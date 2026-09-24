import { fetch, type Dispatcher } from "undici";
import { buildProviderAuthHeaders } from "../providers/provider-request-profile.js";
import type { ProviderAuthScheme } from "../types.js";

export type ResponsesChatFallbackInput = {
  upstreamBaseUrl: string;
  requestBody: Buffer;
  apiKey: string;
  authScheme?: ProviderAuthScheme;
  dispatcher?: Dispatcher;
};

export type ResponsesChatFallbackResult = {
  status: number;
  statusText: string;
  contentType: string;
  body: Buffer;
};

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

export function isResponsesStreamRequest(incomingUrl: string, requestBody: Buffer): boolean {
  const local = new URL(incomingUrl, "http://127.0.0.1");
  if (local.pathname !== "/responses" && local.pathname !== "/v1/responses") return false;
  const body = parseJsonObject(requestBody);
  return body?.stream === true;
}

export type NativeResponsesOutcome = {
  status: number;
  contentType: string;
  bodyText: string;
};

/**
 * Decide whether a failed native `/responses` attempt should be retried by
 * translating the request through chat completions. Only "the upstream does not
 * speak the Responses protocol" cases fall back; transient/no-channel failures
 * are passed through so provider rotation handles them instead of wasting a
 * chat attempt that would fail the same way.
 */
export function shouldFallbackResponsesToChat(outcome: NativeResponsesOutcome): boolean {
  const effectiveStatus = resolveEffectiveStatus(outcome);
  if (effectiveStatus >= 200 && effectiveStatus < 300 && isEventStream(outcome.contentType)) {
    return false;
  }
  if (isTransientStatus(effectiveStatus)) return false;
  if (mentionsResponsesUnsupported(outcome.bodyText)) return true;
  // Classic "this route/endpoint does not exist" from chat-only gateways.
  return effectiveStatus === 400 || effectiveStatus === 404 || effectiveStatus === 405 || effectiveStatus === 501;
}

function resolveEffectiveStatus(outcome: NativeResponsesOutcome): number {
  // Many domestic new-api gateways wrap the real error in an HTTP 200 body,
  // e.g. `{"error":{"message":"... status_code=400 ..."}}`. Trust the wrapped
  // status when the transport status looks successful but the body is an error.
  if (outcome.status >= 200 && outcome.status < 300 && !isEventStream(outcome.contentType)) {
    const wrapped = extractWrappedStatus(outcome.bodyText);
    if (wrapped !== undefined) return wrapped;
  }
  return outcome.status;
}

function extractWrappedStatus(bodyText: string): number | undefined {
  const compact = bodyText.replace(/\s+/g, " ");
  const match = compact.match(/status[_-]?code["']?\s*[:=]\s*["']?(\d{3})/i);
  return match ? Number(match[1]) : undefined;
}

function mentionsResponsesUnsupported(bodyText: string): boolean {
  const message = bodyText.replace(/\s+/g, " ");
  const rejection = "(?:不支持|不支援|does not support|doesn't support|not supported|unsupported|invalid|no such)";
  const protocol = "(?:responses|/v1/responses|response api|responses api)";
  return new RegExp(`${rejection}.{0,160}${protocol}`, "i").test(message)
    || new RegExp(`${protocol}.{0,160}${rejection}`, "i").test(message);
}

function isEventStream(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429
    || status === 500 || status === 502 || status === 503 || status === 504
    || (status >= 520 && status <= 527) || status === 530;
}

export async function buildChatCompletionsResponsesSse(input: ResponsesChatFallbackInput): Promise<ResponsesChatFallbackResult> {
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
      ...(input.authScheme
        ? buildProviderAuthHeaders(input.apiKey, input.authScheme)
        : { authorization: `Bearer ${input.apiKey}` }),
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(buildChatCompletionsRequest(responsesRequest)),
    dispatcher: input.dispatcher
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
