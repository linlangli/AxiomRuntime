import { isModelCompatible } from "./model-filter.js";
import { buildProviderAuthHeaders, getProviderAuthScheme } from "../providers/provider-request-profile.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { getProxyDispatcher, resolveProviderProxy } from "../network/proxy.js";
import type { Dispatcher } from "undici";
import type {
  ConnectivityResult,
  Provider,
  ProviderAuthScheme,
  ProviderRequestProfile,
  TokenUsage
} from "../types.js";

export type CallableModelCheck = {
  model: string;
  status: "ok" | "error" | "unknown";
  error: string | null;
  usage?: TokenUsage;
  attempts?: number;
  durationMs?: number;
  retryErrors?: string[];
};

export type CallableModelCheckOptions = {
  maxAttempts?: number;
  timeoutMs?: number;
};

const RETRY_DELAYS_MS = [0, 200, 600];
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const AUTH_SCHEMES: ProviderAuthScheme[] = ["bearer", "x-api-key", "api-key"];

// 控制面代理解析：Provider 配了代理才显式传 dispatcher；否则省略该选项，
// 让进程全局 dispatcher（cli/index.ts 的 configureGlobalProxy）继续生效。
async function resolveProbeDispatcher(
  provider: Provider,
  globalProxyUrl?: string | null
): Promise<Dispatcher | undefined> {
  const effective = resolveProviderProxy(provider, globalProxyUrl ?? null);
  if (!effective) return undefined;
  return getProxyDispatcher(effective);
}

async function loadProbeDispatcher(provider: Provider): Promise<Dispatcher | undefined> {
  return resolveProbeDispatcher(provider, (await loadRuntimeConfig()).proxyUrl ?? null);
}

export type ProviderProbeResult = ConnectivityResult & {
  provider: Provider;
  modelChecks: CallableModelCheck[];
};

export async function probeProviderConfiguration(provider: Provider): Promise<ProviderProbeResult> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const errors: string[] = [];
  const retryErrors: string[] = [];
  let attempts = 0;
  const dispatcher = await loadProbeDispatcher(provider);

  for (const baseUrl of buildBaseUrlCandidates(provider.baseUrl)) {
    for (const discoveryAuth of AUTH_SCHEMES) {
      const url = `${baseUrl}/models`;
      const result = await fetchTextWithRetry(url, {
        method: "GET",
        headers: {
          ...buildProviderAuthHeaders(provider.apiKey, discoveryAuth),
          Accept: "application/json"
        }
      }, undefined, undefined, dispatcher);
      attempts += result.attempts;
      retryErrors.push(...result.retryErrors);
      if (result.error || !result.response) {
        errors.push(`${describeProbe(baseUrl, discoveryAuth)}: ${result.error ?? "empty response"}`);
        break;
      }
      const { response, text } = result;
      if (!response.ok) {
        errors.push(`${describeProbe(baseUrl, discoveryAuth)}: HTTP ${response.status}`);
        if (response.status === 401 || response.status === 403) continue;
        break;
      }
      if (!looksLikeJson(response.headers.get("content-type") ?? "", text)) {
        errors.push(`${describeProbe(baseUrl, discoveryAuth)}: non-JSON response`);
        break;
      }
      const discoveredModels = extractModels(JSON.parse(text));
      if (!discoveredModels.length) {
        errors.push(`${describeProbe(baseUrl, discoveryAuth)}: no models`);
        break;
      }

      const profile: ProviderRequestProfile = {
        discoveryAuth,
        openaiAuth: discoveryAuth,
        anthropicAuth: discoveryAuth,
        verifiedProtocols: []
      };
      let configuredProvider: Provider = { ...provider, baseUrl, requestProfile: profile };
      const modelChecks: CallableModelCheck[] = [];

      const requestedOpenAiModel = provider.model && isModelCompatible("codex", provider.model)
        ? provider.model
        : null;
      const openaiModel = requestedOpenAiModel
        ?? discoveredModels.find((model) => isModelCompatible("codex", model));
      if (openaiModel) {
        const verified = await probeModelAuth(configuredProvider, openaiModel, "openai", dispatcher);
        attempts += verified.attempts;
        retryErrors.push(...verified.retryErrors);
        modelChecks.push(...verified.checks);
        if (verified.authScheme) {
          profile.openaiAuth = verified.authScheme;
          profile.verifiedProtocols.push("openai");
        }
      }

      const requestedAnthropicModel = provider.model && isModelCompatible("claude", provider.model)
        ? provider.model
        : null;
      const anthropicModel = requestedAnthropicModel
        ?? discoveredModels.find((model) => isModelCompatible("claude", model));
      if (anthropicModel) {
        const verified = await probeModelAuth(configuredProvider, anthropicModel, "anthropic", dispatcher);
        attempts += verified.attempts;
        retryErrors.push(...verified.retryErrors);
        modelChecks.push(...verified.checks);
        if (verified.authScheme) {
          profile.anthropicAuth = verified.authScheme;
          profile.verifiedProtocols.push("anthropic");
        }
      }

      configuredProvider = { ...configuredProvider, requestProfile: profile };
      const requestedModelVerified = Boolean(
        (requestedOpenAiModel && profile.verifiedProtocols.includes("openai"))
        || (requestedAnthropicModel && profile.verifiedProtocols.includes("anthropic"))
      );
      const verifiedModels = provider.model && requestedModelVerified
        ? [...new Set([...discoveredModels, provider.model])]
        : discoveredModels;
      const models = verifiedModels.filter((model) => {
        if (isModelCompatible("claude", model)) return profile.verifiedProtocols.includes("anthropic");
        if (isModelCompatible("codex", model)) return profile.verifiedProtocols.includes("openai");
        return true;
      });
      if (!models.length) {
        errors.push(`${describeProbe(baseUrl, discoveryAuth)}: no callable models`);
        continue;
      }

      return {
        status: "ok",
        models,
        checkedAt,
        error: null,
        attempts,
        durationMs: Date.now() - startedAt,
        retryErrors,
        provider: configuredProvider,
        modelChecks
      };
    }
  }

  if (provider.model) {
    const protocol = isModelCompatible("codex", provider.model)
      ? "openai"
      : isModelCompatible("claude", provider.model)
        ? "anthropic"
        : null;
    if (!protocol) {
      errors.push(`Configured model ${provider.model} is not compatible with Claude or Codex.`);
    } else {
      for (const baseUrl of buildBaseUrlCandidates(provider.baseUrl)) {
        const profile: ProviderRequestProfile = {
          discoveryAuth: "bearer",
          openaiAuth: "bearer",
          anthropicAuth: "bearer",
          verifiedProtocols: []
        };
        const candidate: Provider = { ...provider, baseUrl, requestProfile: profile };
        const verified = await probeModelAuth(candidate, provider.model, protocol, dispatcher);
        attempts += verified.attempts;
        retryErrors.push(...verified.retryErrors);
        if (verified.authScheme) {
          if (protocol === "openai") profile.openaiAuth = verified.authScheme;
          else profile.anthropicAuth = verified.authScheme;
          profile.verifiedProtocols.push(protocol);
          return {
            status: "ok",
            models: [provider.model],
            checkedAt,
            error: null,
            attempts,
            durationMs: Date.now() - startedAt,
            retryErrors,
            provider: { ...candidate, requestProfile: profile },
            modelChecks: verified.checks
          };
        }
        const lastError = verified.checks.at(-1)?.error ?? "model verification failed";
        errors.push(`${baseUrl} (${protocol}, model ${provider.model}): ${lastError}`);
      }
    }
  }

  return {
    status: "error",
    models: [],
    checkedAt,
    error: summarizeProbeErrors(errors),
    attempts,
    durationMs: Date.now() - startedAt,
    retryErrors,
    provider,
    modelChecks: []
  };
}

export async function checkProvider(provider: Provider): Promise<ConnectivityResult> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const errors: string[] = [];
  const retryErrors: string[] = [];
  let attempts = 0;
  const dispatcher = await loadProbeDispatcher(provider);
  try {
    for (const url of buildModelUrlCandidates(provider.baseUrl)) {
      const result = await fetchTextWithRetry(url, {
        method: "GET",
        headers: {
          ...buildProviderAuthHeaders(provider.apiKey, getProviderAuthScheme(provider, "discovery")),
          Accept: "application/json"
        }
      }, undefined, undefined, dispatcher);
      attempts += result.attempts;
      retryErrors.push(...result.retryErrors);
      if (result.error || !result.response) {
        errors.push(`GET ${url} failed: ${result.error ?? "empty response"}`);
        continue;
      }

      const { response, text } = result;

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
        status: models.length ? "ok" : "error",
        models,
        checkedAt,
        error: models.length ? null : "Provider responded but no models were found.",
        attempts,
        durationMs: Date.now() - startedAt,
        retryErrors
      };
    }

    return {
      status: "error",
      models: [],
      checkedAt,
      error: errors.join("; ") || "No model discovery endpoint worked.",
      attempts,
      durationMs: Date.now() - startedAt,
      retryErrors
    };
  } catch (error) {
    return {
      status: "error",
      models: [],
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
      attempts,
      durationMs: Date.now() - startedAt,
      retryErrors
    };
  }
}

export async function runDeepCheck(provider: Provider, model: string): Promise<ConnectivityResult> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const dispatcher = await loadProbeDispatcher(provider);
  try {
    const url = buildChatCompletionsUrl(provider.baseUrl);
    const result = await fetchTextWithRetry(url, {
      method: "POST",
      headers: {
        ...buildProviderAuthHeaders(provider.apiKey, getProviderAuthScheme(provider, "openai")),
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0
      })
    }, undefined, undefined, dispatcher);
    if (result.error || !result.response) {
      return {
        status: "error",
        models: [],
        checkedAt,
        error: result.error ?? "empty response",
        attempts: result.attempts,
        durationMs: Date.now() - startedAt,
        retryErrors: result.retryErrors
      };
    }

    const { response, text } = result;
    if (!response.ok) {
      return {
        status: "error",
        models: [],
        checkedAt,
        error: `POST ${url} failed with ${response.status} ${response.statusText}`,
        attempts: result.attempts,
        durationMs: Date.now() - startedAt,
        retryErrors: result.retryErrors
      };
    }

    const json = looksLikeJson(response.headers.get("content-type") ?? "", text) ? JSON.parse(text) : {};
    return {
      status: "ok",
      models: [model],
      checkedAt,
      error: null,
      usage: extractTokenUsage(json),
      attempts: result.attempts,
      durationMs: Date.now() - startedAt,
      retryErrors: result.retryErrors
    };
  } catch (error) {
    return {
      status: "error",
      models: [],
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
      attempts: 1,
      durationMs: Date.now() - startedAt,
      retryErrors: []
    };
  }
}

export async function checkCallableModels(
  provider: Provider,
  models: string[],
  options: CallableModelCheckOptions = {}
): Promise<CallableModelCheck[]> {
  const uniqueModels = [...new Set(models.filter(Boolean))];
  const dispatcher = await loadProbeDispatcher(provider);
  return mapWithConcurrency(uniqueModels, 3, (model) => checkCallableModel(provider, model, options, dispatcher));
}

async function checkCallableModel(
  provider: Provider,
  model: string,
  options: CallableModelCheckOptions,
  dispatcher?: Dispatcher
): Promise<CallableModelCheck> {
  const lower = model.toLowerCase();
  return lower.includes("claude")
    ? checkAnthropicMessagesModel(provider, model, options, dispatcher)
    : checkOpenAiModel(provider, model, options, dispatcher);
}

async function checkAnthropicMessagesModel(
  provider: Provider,
  model: string,
  options: CallableModelCheckOptions = {},
  dispatcher?: Dispatcher
): Promise<CallableModelCheck> {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const url = `${baseUrl}/v1/messages`;
  const payload = {
    model,
    max_tokens: 1,
    messages: [{ role: "user", content: "." }]
  };
  const headers = {
    ...buildProviderAuthHeaders(provider.apiKey, getProviderAuthScheme(provider, "anthropic")),
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  return postModelProbe(url, headers, payload, model, options, dispatcher);
}

async function checkChatCompletionsModel(
  provider: Provider,
  model: string,
  options: CallableModelCheckOptions = {},
  dispatcher?: Dispatcher
): Promise<CallableModelCheck> {
  const payload = {
    model,
    messages: [{ role: "user", content: "." }],
    max_tokens: 1,
    temperature: 0
  };
  const headers = {
    ...buildProviderAuthHeaders(provider.apiKey, getProviderAuthScheme(provider, "openai")),
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  let lastResult: CallableModelCheck | null = null;
  for (const url of buildChatCompletionsUrlCandidates(provider.baseUrl)) {
    const result = await postModelProbe(url, headers, payload, model, options, dispatcher);
    if (result.status === "ok" || result.status === "unknown") return result;
    lastResult = result;
  }
  return lastResult ?? { model, status: "error", error: "No chat completions endpoint worked." };
}

async function probeModelAuth(
  provider: Provider,
  model: string,
  protocol: "openai" | "anthropic",
  dispatcher?: Dispatcher
): Promise<{
  authScheme: ProviderAuthScheme | null;
  checks: CallableModelCheck[];
  attempts: number;
  retryErrors: string[];
}> {
  const preferred = getProviderAuthScheme(provider, "discovery");
  const schemes = [preferred, ...AUTH_SCHEMES.filter((scheme) => scheme !== preferred)];
  const checks: CallableModelCheck[] = [];
  for (const authScheme of schemes) {
    const requestProfile = {
      ...provider.requestProfile!,
      ...(protocol === "openai" ? { openaiAuth: authScheme } : { anthropicAuth: authScheme })
    };
    const candidate = { ...provider, requestProfile };
    const check = protocol === "openai"
      ? await checkOpenAiModel(candidate, model, undefined, dispatcher)
      : await checkAnthropicMessagesModel(candidate, model, undefined, dispatcher);
    checks.push(check);
    if (check.status === "ok") {
      return {
        authScheme,
        checks,
        attempts: checks.reduce((sum, item) => sum + (item.attempts ?? 0), 0),
        retryErrors: checks.flatMap((item) => item.retryErrors ?? [])
      };
    }
    if (!isAuthenticationFailure(check.error)) break;
  }
  return {
    authScheme: null,
    checks,
    attempts: checks.reduce((sum, item) => sum + (item.attempts ?? 0), 0),
    retryErrors: checks.flatMap((item) => item.retryErrors ?? [])
  };
}

function isAuthenticationFailure(error: string | null): boolean {
  return Boolean(error && /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication|invalid api key)/i.test(error));
}

async function checkOpenAiModel(
  provider: Provider,
  model: string,
  options: CallableModelCheckOptions | undefined = {},
  dispatcher?: Dispatcher
): Promise<CallableModelCheck> {
  const headers = {
    ...buildProviderAuthHeaders(provider.apiKey, getProviderAuthScheme(provider, "openai")),
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  const responsesResult = await postModelProbe(
    `${provider.baseUrl.replace(/\/+$/, "")}/responses`,
    headers,
    { model, input: ".", max_output_tokens: 1, stream: false },
    model,
    options,
    dispatcher
  );
  if (responsesResult.status === "ok" || responsesResult.status === "unknown") return responsesResult;
  if (!shouldFallbackFromResponses(responsesResult.error)) return responsesResult;
  const chatResult = await checkChatCompletionsModel(provider, model, options, dispatcher);
  return chatResult.status === "ok"
    ? chatResult
    : {
        ...chatResult,
        error: `${responsesResult.error ?? "Responses probe failed."}; ${chatResult.error ?? "Chat probe failed."}`,
        attempts: (responsesResult.attempts ?? 0) + (chatResult.attempts ?? 0),
        durationMs: (responsesResult.durationMs ?? 0) + (chatResult.durationMs ?? 0),
        retryErrors: [...(responsesResult.retryErrors ?? []), ...(chatResult.retryErrors ?? [])]
      };
}

function shouldFallbackFromResponses(error: string | null): boolean {
  return Boolean(error && /(?:\b400\b|\b404\b|\b405\b|\b422\b|unsupported|not supported)/i.test(error));
}

async function postModelProbe(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  model: string,
  options: CallableModelCheckOptions = {},
  dispatcher?: Dispatcher
): Promise<CallableModelCheck> {
  try {
    const result = await fetchTextWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    }, options.maxAttempts, options.timeoutMs, dispatcher);
    if (result.error || !result.response) {
      return {
        model,
        status: result.timedOut ? "unknown" : "error",
        error: result.error ?? "empty response",
        attempts: result.attempts,
        durationMs: result.durationMs,
        retryErrors: result.retryErrors
      };
    }
    const { response, text } = result;
    const json = looksLikeJson(response.headers.get("content-type") ?? "", text) ? JSON.parse(text) : {};
    if (!response.ok) {
      return {
        model,
        status: "error",
        error: `POST ${url} failed with ${response.status} ${response.statusText}${extractErrorMessage(json)}`,
        attempts: result.attempts,
        durationMs: result.durationMs,
        retryErrors: result.retryErrors
      };
    }
    if (extractErrorMessage(json)) {
      return {
        model,
        status: "error",
        error: `POST ${url} returned an error${extractErrorMessage(json)}`,
        attempts: result.attempts,
        durationMs: result.durationMs,
        retryErrors: result.retryErrors
      };
    }
    return {
      model,
      status: "ok",
      error: null,
      usage: extractTokenUsage(json),
      attempts: result.attempts,
      durationMs: result.durationMs,
      retryErrors: result.retryErrors
    };
  } catch (error) {
    return {
      model,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      attempts: 1,
      durationMs: 0,
      retryErrors: []
    };
  }
}

export function extractTokenUsage(value: unknown): TokenUsage | undefined {
  const usage = (value as { usage?: unknown })?.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const data = usage as Record<string, unknown>;
  const rawInputTokens = readNumber(data, ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens"]);
  const outputTokens = readNumber(data, ["output_tokens", "completion_tokens", "outputTokens", "completionTokens"]);
  const totalTokens = readNumber(data, ["total_tokens", "totalTokens"]);
  const cacheReadInputTokens = readCacheReadInputTokens(data);
  const cacheCreationInputTokens = readNumber(data, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_tokens",
    "cacheCreationTokens"
  ]) ?? 0;

  if (
    rawInputTokens === undefined
    && outputTokens === undefined
    && totalTokens === undefined
    && cacheReadInputTokens === undefined
  ) {
    return undefined;
  }

  const input = normalizeInputTokens(data, rawInputTokens ?? 0, cacheReadInputTokens ?? 0, cacheCreationInputTokens);
  const output = outputTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: totalTokens ?? input + output,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {})
  };
}

function normalizeInputTokens(
  data: Record<string, unknown>,
  rawInputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number
): number {
  return hasNestedCachedTokens(data)
    ? rawInputTokens
    : rawInputTokens + cacheReadInputTokens + cacheCreationInputTokens;
}

function readCacheReadInputTokens(data: Record<string, unknown>): number | undefined {
  return readNumber(data, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
    "cacheReadTokens",
    "cached_tokens",
    "cachedTokens"
  ])
    ?? readNumberFromRecord(data.prompt_tokens_details, ["cached_tokens", "cachedTokens"])
    ?? readNumberFromRecord(data.input_tokens_details, ["cached_tokens", "cachedTokens", "cache_read_tokens", "cacheReadTokens"]);
}

function hasNestedCachedTokens(data: Record<string, unknown>): boolean {
  return readNumberFromRecord(data.prompt_tokens_details, ["cached_tokens", "cachedTokens"]) !== undefined
    || readNumberFromRecord(data.input_tokens_details, ["cached_tokens", "cachedTokens", "cache_read_tokens", "cacheReadTokens"]) !== undefined;
}

function readNumberFromRecord(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return readNumber(value as Record<string, unknown>, keys);
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

function buildBaseUrlCandidates(baseUrl: string): string[] {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  const toggled = normalized.endsWith("/v1")
    ? normalized.slice(0, -3).replace(/\/+$/, "")
    : `${normalized}/v1`;
  return [...new Set([normalized, toggled].filter(Boolean))];
}

function describeProbe(baseUrl: string, authScheme: ProviderAuthScheme): string {
  try {
    const safeUrl = new URL(`${baseUrl}/models`);
    safeUrl.search = "";
    safeUrl.hash = "";
    return `${safeUrl.toString()} (${authScheme})`;
  } catch {
    return `<invalid-url> (${authScheme})`;
  }
}

function summarizeProbeErrors(errors: string[]): string {
  if (!errors.length) return "No provider configuration candidate worked.";
  const visible = errors.slice(-6);
  const omitted = errors.length - visible.length;
  return `${omitted > 0 ? `${omitted} earlier attempt(s) omitted; ` : ""}${visible.join("; ")}`;
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

type FetchTextResult = {
  response?: Response;
  text: string;
  error?: string;
  timedOut?: boolean;
  attempts: number;
  durationMs: number;
  retryErrors: string[];
};

async function fetchTextWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = RETRY_DELAYS_MS.length,
  timeoutMs = 12000,
  dispatcher?: Dispatcher
): Promise<FetchTextResult> {
  const startedAt = Date.now();
  const retryErrors: string[] = [];
  const retryDelays = RETRY_DELAYS_MS.slice(0, Math.max(1, Math.min(RETRY_DELAYS_MS.length, maxAttempts)));

  for (const [index, delayMs] of retryDelays.entries()) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const attempt = index + 1;
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs, dispatcher);
      const text = await response.text();
      if (!shouldRetryResponse(response) || attempt >= retryDelays.length) {
        return {
          response,
          text,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
          retryErrors
        };
      }
      retryErrors.push(`attempt ${attempt}: ${response.status} ${response.statusText}`);
    } catch (error) {
      const timedOut = isAbortError(error);
      const message = timedOut
        ? `Request timed out after ${timeoutMs}ms; the upstream may still have completed it.`
        : error instanceof Error ? error.message : String(error);
      if (attempt >= retryDelays.length) {
        return {
          text: "",
          error: message,
          timedOut,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
          retryErrors
        };
      }
      retryErrors.push(`attempt ${attempt}: ${message}`);
    }
  }

  return {
    text: "",
    error: "Request failed after retries.",
    attempts: retryDelays.length,
    durationMs: Date.now() - startedAt,
    retryErrors
  };
}

function shouldRetryResponse(response: Response): boolean {
  return RETRYABLE_STATUS_CODES.has(response.status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /operation was aborted/i.test(error.message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 12000,
  dispatcher?: Dispatcher
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // init.dispatcher 是 undici fetch 的原生选项；无代理时省略，让进程全局 dispatcher 生效。
    const probeInit = { ...init, ...(dispatcher ? { dispatcher } : {}) } as RequestInit;
    return await fetch(url, { ...probeInit, signal: controller.signal });
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
