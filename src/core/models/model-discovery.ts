import type { ConnectivityResult, Provider, TokenUsage } from "../types.js";

export type CallableModelCheck = {
  model: string;
  status: "ok" | "error";
  error: string | null;
  usage?: TokenUsage;
};

export async function checkProvider(provider: Provider): Promise<ConnectivityResult> {
  const checkedAt = new Date().toISOString();
  const errors: string[] = [];
  try {
    for (const url of buildModelUrlCandidates(provider.baseUrl)) {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          Accept: "application/json"
        }
      });

      const text = await response.text();
      if (!response.ok) {
        errors.push(`GET ${url} failed with ${response.status} ${response.statusText}`);
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!looksLikeJson(contentType, text)) {
        errors.push(`GET ${url} returned ${contentType || "non-JSON response"}. Base URL may need /v1.`);
        continue;
      }

      const models = extractModels(JSON.parse(text));
      return {
        status: "ok",
        models,
        checkedAt,
        error: models.length ? null : "Provider responded but no models were found."
      };
    }

    return {
      status: "error",
      models: [],
      checkedAt,
      error: errors.join("; ") || "No model discovery endpoint worked."
    };
  } catch (error) {
    return {
      status: "error",
      models: [],
      checkedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function runDeepCheck(provider: Provider, model: string): Promise<ConnectivityResult> {
  const checkedAt = new Date().toISOString();
  try {
    const url = buildChatCompletionsUrl(provider.baseUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0
      })
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        status: "error",
        models: [],
        checkedAt,
        error: `POST ${url} failed with ${response.status} ${response.statusText}`
      };
    }

    const json = looksLikeJson(response.headers.get("content-type") ?? "", text) ? JSON.parse(text) : {};
    return {
      status: "ok",
      models: [model],
      checkedAt,
      error: null,
      usage: extractTokenUsage(json)
    };
  } catch (error) {
    return {
      status: "error",
      models: [],
      checkedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function checkCallableModels(provider: Provider, models: string[]): Promise<CallableModelCheck[]> {
  const uniqueModels = [...new Set(models.filter(Boolean))];
  return mapWithConcurrency(uniqueModels, 3, (model) => checkCallableModel(provider, model));
}

async function checkCallableModel(provider: Provider, model: string): Promise<CallableModelCheck> {
  const lower = model.toLowerCase();
  return lower.includes("claude")
    ? checkAnthropicMessagesModel(provider, model)
    : checkChatCompletionsModel(provider, model);
}

async function checkAnthropicMessagesModel(provider: Provider, model: string): Promise<CallableModelCheck> {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const url = `${baseUrl}/v1/messages`;
  const payload = {
    model,
    max_tokens: 1,
    messages: [{ role: "user", content: "." }]
  };
  const headers = {
    "x-api-key": provider.apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  return postModelProbe(url, headers, payload, model);
}

async function checkChatCompletionsModel(provider: Provider, model: string): Promise<CallableModelCheck> {
  const payload = {
    model,
    messages: [{ role: "user", content: "." }],
    max_tokens: 1,
    temperature: 0
  };
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  let lastResult: CallableModelCheck | null = null;
  for (const url of buildChatCompletionsUrlCandidates(provider.baseUrl)) {
    const result = await postModelProbe(url, headers, payload, model);
    if (result.status === "ok") return result;
    lastResult = result;
  }
  return lastResult ?? { model, status: "error", error: "No chat completions endpoint worked." };
}

async function postModelProbe(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  model: string
): Promise<CallableModelCheck> {
  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    const json = looksLikeJson(response.headers.get("content-type") ?? "", text) ? JSON.parse(text) : {};
    if (!response.ok) {
      return {
        model,
        status: "error",
        error: `POST ${url} failed with ${response.status} ${response.statusText}${extractErrorMessage(json)}`
      };
    }
    return {
      model,
      status: "ok",
      error: null,
      usage: extractTokenUsage(json)
    };
  } catch (error) {
    return {
      model,
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function extractTokenUsage(value: unknown): TokenUsage | undefined {
  const usage = (value as { usage?: unknown })?.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const data = usage as Record<string, unknown>;
  const inputTokens = readNumber(data, ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens"]);
  const outputTokens = readNumber(data, ["output_tokens", "completion_tokens", "outputTokens", "completionTokens"]);
  const totalTokens = readNumber(data, ["total_tokens", "totalTokens"]);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: totalTokens ?? input + output
  };
}

function readNumber(data: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function buildModelUrlCandidates(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, "");
  const candidates = [`${normalized}/models`];
  if (!normalized.endsWith("/v1")) {
    candidates.push(`${normalized}/v1/models`);
  }
  return candidates;
}

function buildChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function buildChatCompletionsUrlCandidates(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, "");
  const candidates = [`${normalized}/chat/completions`];
  if (!normalized.endsWith("/v1")) {
    candidates.push(`${normalized}/v1/chat/completions`);
  }
  return candidates;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeJson(contentType: string, text: string): boolean {
  const trimmed = text.trim();
  return contentType.includes("application/json") || trimmed.startsWith("{") || trimmed.startsWith("[");
}

function extractModels(value: unknown): string[] {
  const payload = value as { data?: unknown; models?: unknown };
  const source = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : Array.isArray(value)
        ? value
        : [];

  const models = source
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && "id" in entry) {
        return String((entry as { id: unknown }).id);
      }
      if (entry && typeof entry === "object" && "name" in entry) {
        return String((entry as { name: unknown }).name);
      }
      return "";
    })
    .filter(Boolean);

  return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

function extractErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const data = value as Record<string, unknown>;
  const error = data.error;
  if (typeof error === "string") return `: ${error}`;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return `: ${message}`;
  }
  const message = data.message;
  return typeof message === "string" ? `: ${message}` : "";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]!);
    }
  });
  await Promise.all(workers);
  return results;
}
