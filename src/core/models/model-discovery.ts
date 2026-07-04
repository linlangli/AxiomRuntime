import type { ConnectivityResult, Provider } from "../types.js";

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

    if (!response.ok) {
      return {
        status: "error",
        models: [],
        checkedAt,
        error: `POST ${url} failed with ${response.status} ${response.statusText}`
      };
    }

    return {
      status: "ok",
      models: [model],
      checkedAt,
      error: null
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
