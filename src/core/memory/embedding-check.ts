import { updateMemoryEmbeddingCheck } from "./memory-config.js";
import type { MemoryEmbeddingConfig } from "../types.js";

export type MemoryEmbeddingCheckResult = {
  status: "ok" | "error";
  model: string;
  dimensions: number | null;
  checkedAt: string;
  error: string | null;
};

export async function checkMemoryEmbeddingConfig(
  config: MemoryEmbeddingConfig,
  text = "ping",
  inputKind: "query" | "passage" = "query"
): Promise<MemoryEmbeddingCheckResult> {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetchWithTimeout(buildEmbeddingsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(buildEmbeddingPayload(config, text, inputKind))
    });
    const raw = await response.text();
    const json = parseJson(raw);
    const embedding = readEmbedding(json);
    if (!response.ok) {
      return {
        status: "error",
        model: config.model,
        dimensions: null,
        checkedAt,
        error: `POST embeddings failed with ${response.status} ${response.statusText}${extractErrorMessage(json)}`
      };
    }
    if (!embedding) {
      return {
        status: "error",
        model: config.model,
        dimensions: null,
        checkedAt,
        error: "Embedding response did not include data[0].embedding."
      };
    }
    return {
      status: "ok",
      model: config.model,
      dimensions: embedding.length,
      checkedAt,
      error: null
    };
  } catch (error) {
    return {
      status: "error",
      model: config.model,
      dimensions: null,
      checkedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function checkAndRecordMemoryEmbeddingConfig(
  config: MemoryEmbeddingConfig,
  text?: string,
  inputKind?: "query" | "passage"
): Promise<MemoryEmbeddingCheckResult> {
  const result = await checkMemoryEmbeddingConfig(config, text, inputKind);
  await updateMemoryEmbeddingCheck({
    dimensions: result.dimensions,
    checkedAt: result.checkedAt,
    error: result.error
  });
  return result;
}

function buildEmbeddingsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/embeddings") ? normalized : `${normalized}/embeddings`;
}

function buildEmbeddingPayload(
  config: MemoryEmbeddingConfig,
  text: string,
  inputKind: "query" | "passage"
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: config.model,
    input: [text]
  };
  if (config.providerType === "jina") {
    const task = inputKind === "query" ? config.queryTask : config.passageTask;
    if (task) payload.task = task;
  }
  return payload;
}

function readEmbedding(value: unknown): number[] | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") return null;
  const embedding = (data[0] as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding) || !embedding.length) return null;
  return embedding.every((item) => typeof item === "number") ? embedding : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
