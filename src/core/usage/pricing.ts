import { getModelPricingPath } from "../config/paths.js";
import { readJsonFile, writeJsonFile } from "../config/json-store.js";
import type { TokenUsage } from "../types.js";

export type ModelPrice = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
};

export type ModelPricingTable = Record<string, ModelPrice>;

export async function readModelPricing(): Promise<ModelPricingTable> {
  const raw = await readJsonFile<unknown>(getModelPricingPath(), {});
  return normalizePricingTable(raw);
}

export async function estimateTokenCostUsdFromConfig(
  providerName: string,
  model: string,
  usage: TokenUsage
): Promise<number | undefined> {
  return estimateTokenCostUsd(providerName, model, usage, await readModelPricing());
}

export async function upsertModelPrice(providerName: string, model: string, price: ModelPrice): Promise<ModelPricingTable> {
  const pricing = await readModelPricing();
  const key = getProviderModelPricingKey(providerName, model);
  const next = {
    ...pricing,
    [key]: price
  };
  await writeJsonFile(getModelPricingPath(), next);
  return next;
}

export function getProviderModelPricingKey(providerName: string, model: string): string {
  return `${providerName.trim()}/${model.trim()}`;
}

export function estimateTokenCostUsd(
  providerName: string,
  model: string,
  usage: TokenUsage,
  pricing: ModelPricingTable
): number | undefined {
  const price = resolveModelPrice(providerName, model, pricing);
  if (!price) return undefined;

  const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;
  const regularInputTokens = Math.max(0, usage.inputTokens - cacheReadInputTokens);
  const cacheReadPrice = price.cacheReadPerMillionUsd ?? price.inputPerMillionUsd;
  const cost = (
    regularInputTokens * price.inputPerMillionUsd
    + cacheReadInputTokens * cacheReadPrice
    + usage.outputTokens * price.outputPerMillionUsd
  ) / 1_000_000;
  return Number(cost.toFixed(8));
}

export function normalizePricingTable(value: unknown): ModelPricingTable {
  const source = isRecord(value) && isRecord(value.models) ? value.models : value;
  if (!isRecord(source)) return {};

  const table: ModelPricingTable = {};
  for (const [key, rawPrice] of Object.entries(source)) {
    const price = normalizeModelPrice(rawPrice);
    if (key.trim() && price) {
      table[key.trim()] = price;
    }
  }
  return table;
}

function resolveModelPrice(providerName: string, model: string, pricing: ModelPricingTable): ModelPrice | undefined {
  const keys = [
    `${providerName}/${model}`,
    `${providerName}:${model}`,
    model
  ];
  for (const key of keys) {
    const exact = pricing[key];
    if (exact) return exact;
    const lower = Object.entries(pricing).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
    if (lower) return lower[1];
  }
  return undefined;
}

function normalizeModelPrice(value: unknown): ModelPrice | null {
  if (!isRecord(value)) return null;
  const inputPerMillionUsd = readFiniteNumber(value, [
    "inputPerMillionUsd",
    "input_per_million_usd",
    "input",
    "promptPerMillionUsd",
    "prompt_per_million_usd"
  ]);
  const outputPerMillionUsd = readFiniteNumber(value, [
    "outputPerMillionUsd",
    "output_per_million_usd",
    "output",
    "completionPerMillionUsd",
    "completion_per_million_usd"
  ]);
  if (inputPerMillionUsd === undefined || outputPerMillionUsd === undefined) return null;
  const cacheReadPerMillionUsd = readFiniteNumber(value, [
    "cacheReadPerMillionUsd",
    "cache_read_per_million_usd",
    "cacheRead",
    "cache_read",
    "cachedInputPerMillionUsd",
    "cached_input_per_million_usd",
    "cachedInput",
    "cached_input"
  ]);
  if (inputPerMillionUsd < 0 || outputPerMillionUsd < 0) return null;
  if (cacheReadPerMillionUsd !== undefined && cacheReadPerMillionUsd < 0) return null;
  return {
    inputPerMillionUsd,
    outputPerMillionUsd,
    ...(cacheReadPerMillionUsd !== undefined ? { cacheReadPerMillionUsd } : {})
  };
}

function readFiniteNumber(data: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
