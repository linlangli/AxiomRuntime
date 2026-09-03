import fs from "node:fs/promises";
import { getReviewConfigPath } from "../config/paths.js";
import { readJsonFile, writeJsonFile } from "../config/json-store.js";
import type { ReviewConfig, ReviewEngineConfig, ReviewEngineName } from "./types.js";

export async function readReviewConfig(): Promise<ReviewConfig | null> {
  const raw = await readJsonFile<unknown>(getReviewConfigPath(), null);
  return raw === null ? null : normalizeReviewConfig(raw);
}

export async function writeReviewConfig(config: ReviewConfig): Promise<ReviewConfig> {
  const normalized = normalizeReviewConfig(config);
  await writeJsonFile(getReviewConfigPath(), normalized);
  await fs.chmod(getReviewConfigPath(), 0o600);
  return normalized;
}

export async function clearReviewConfig(): Promise<void> {
  await fs.rm(getReviewConfigPath(), { force: true });
}

export function normalizeReviewConfig(value: unknown): ReviewConfig {
  if (!isRecord(value)) {
    throw new Error("review.json must contain a JSON object.");
  }
  const firstEngine = normalizeEngine(value.firstEngine);
  return {
    version: 1,
    firstEngine,
    claude: normalizeEngineConfig(value.claude, "claude"),
    codex: normalizeEngineConfig(value.codex, "codex")
  };
}

function normalizeEngine(value: unknown): ReviewEngineName {
  if (value === "claude" || value === "codex") return value;
  throw new Error("review.json firstEngine must be claude or codex.");
}

function normalizeEngineConfig(value: unknown, engine: ReviewEngineName): ReviewEngineConfig {
  if (!isRecord(value)) {
    throw new Error(`review.json ${engine} config is missing.`);
  }
  const provider = readNonEmptyString(value.provider, `${engine}.provider`);
  const model = readNonEmptyString(value.model, `${engine}.model`);
  return { provider, model };
}

function readNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`review.json ${field} cannot be empty.`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
