import { getMemoryConfigPath } from "../config/paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "../config/json-store.js";
import { readNumber, readOptionalString, readRecord, readString } from "../config/schema.js";
import type { MemoryConfigFile, MemoryEmbeddingConfig, MemoryEmbeddingProviderType } from "../types.js";

export type SetMemoryEmbeddingInput = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerType?: MemoryEmbeddingProviderType;
  queryTask?: string;
  passageTask?: string;
  dimensions?: number | null;
};

const DEFAULT_MEMORY_CONFIG: MemoryConfigFile = {
  embedding: null
};

const VALID_PROVIDER_TYPES = new Set<MemoryEmbeddingProviderType>(["openai-compatible", "jina"]);

export async function readMemoryConfig(): Promise<MemoryConfigFile> {
  return normalizeMemoryConfig(await readJsonFile<unknown>(getMemoryConfigPath(), DEFAULT_MEMORY_CONFIG));
}

export async function writeMemoryConfig(config: MemoryConfigFile): Promise<void> {
  await writeJsonFile(getMemoryConfigPath(), normalizeMemoryConfig(config));
}

export async function getMemoryEmbeddingConfig(): Promise<MemoryEmbeddingConfig | null> {
  return (await readMemoryConfig()).embedding;
}

export async function setMemoryEmbeddingConfig(input: SetMemoryEmbeddingInput): Promise<MemoryEmbeddingConfig> {
  const next = normalizeMemoryEmbeddingConfig({
    enabled: true,
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    providerType: input.providerType ?? inferProviderType(input.name, input.baseUrl, input.model),
    queryTask: input.queryTask,
    passageTask: input.passageTask,
    dimensions: input.dimensions ?? null,
    updatedAt: new Date().toISOString(),
    lastCheckedAt: null,
    lastError: null
  });
  await updateJsonFile<MemoryConfigFile>(getMemoryConfigPath(), DEFAULT_MEMORY_CONFIG, (current) => ({
    ...normalizeMemoryConfig(current),
    embedding: next
  }));
  return next;
}

export async function updateMemoryEmbeddingCheck(result: {
  dimensions?: number | null;
  checkedAt: string;
  error: string | null;
}): Promise<MemoryEmbeddingConfig | null> {
  const updated = await updateJsonFile<MemoryConfigFile>(getMemoryConfigPath(), DEFAULT_MEMORY_CONFIG, (current) => {
    const normalized = normalizeMemoryConfig(current);
    if (!normalized.embedding) return normalized;
    return {
      ...normalized,
      embedding: {
        ...normalized.embedding,
        dimensions: result.dimensions ?? normalized.embedding.dimensions,
        lastCheckedAt: result.checkedAt,
        lastError: result.error
      }
    };
  });
  return updated.embedding;
}

export async function clearMemoryEmbeddingConfig(): Promise<boolean> {
  const previous = await readMemoryConfig();
  await updateJsonFile<MemoryConfigFile>(getMemoryConfigPath(), DEFAULT_MEMORY_CONFIG, (current) => ({
    ...normalizeMemoryConfig(current),
    embedding: null
  }));
  return previous.embedding !== null;
}

export function normalizeMemoryConfig(value: unknown): MemoryConfigFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_MEMORY_CONFIG;
  }
  const record = value as Record<string, unknown>;
  return {
    embedding: record.embedding ? normalizeMemoryEmbeddingConfig(record.embedding) : null
  };
}

function normalizeMemoryEmbeddingConfig(value: unknown): MemoryEmbeddingConfig {
  const record = readRecord(value, "memory.embedding");
  const name = readString(record, "name");
  const baseUrl = readString(record, "baseUrl").replace(/\/+$/, "");
  const apiKey = readString(record, "apiKey");
  const model = readString(record, "model");
  if (!name) throw new Error("Memory embedding provider name cannot be empty.");
  if (!baseUrl) throw new Error("Memory embedding baseUrl cannot be empty.");
  if (!apiKey) throw new Error("Memory embedding apiKey cannot be empty.");
  if (!model) throw new Error("Memory embedding model cannot be empty.");

  const rawProviderType = readString(record, "providerType", {
    fallback: inferProviderType(name, baseUrl, model)
  });
  const providerType = VALID_PROVIDER_TYPES.has(rawProviderType as MemoryEmbeddingProviderType)
    ? rawProviderType as MemoryEmbeddingProviderType
    : inferProviderType(name, baseUrl, model);
  const queryTask = readOptionalString(record, "queryTask") ?? defaultQueryTask(providerType);
  const passageTask = readOptionalString(record, "passageTask") ?? defaultPassageTask(providerType);
  const dimensions = normalizeDimensions(readNumber(record, "dimensions", 0));
  return {
    enabled: record.enabled === false ? false : true,
    name,
    baseUrl,
    apiKey,
    model,
    providerType,
    ...(queryTask ? { queryTask } : {}),
    ...(passageTask ? { passageTask } : {}),
    dimensions,
    updatedAt: readString(record, "updatedAt", { fallback: new Date().toISOString() }),
    lastCheckedAt: readOptionalString(record, "lastCheckedAt") ?? null,
    lastError: readOptionalString(record, "lastError") ?? null
  };
}

function inferProviderType(name: string, baseUrl: string, model: string): MemoryEmbeddingProviderType {
  const value = `${name} ${baseUrl} ${model}`.toLowerCase();
  return value.includes("jina") ? "jina" : "openai-compatible";
}

function defaultQueryTask(providerType: MemoryEmbeddingProviderType): string | undefined {
  return providerType === "jina" ? "retrieval.query" : undefined;
}

function defaultPassageTask(providerType: MemoryEmbeddingProviderType): string | undefined {
  return providerType === "jina" ? "retrieval.passage" : undefined;
}

function normalizeDimensions(value: number): number | null {
  return Number.isInteger(value) && value > 0 ? value : null;
}
