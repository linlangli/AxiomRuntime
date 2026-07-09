import { isRecord } from "../utils/is-record.js";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConfigValidationError(`${path} must be an object.`);
  }
  return value;
}

export function readString(
  record: Record<string, unknown>,
  key: string,
  options: { fallback?: string; trim?: boolean } = {}
): string {
  const value = record[key] ?? options.fallback ?? "";
  const text = String(value);
  return options.trim === false ? text : text.trim();
}

export function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

export function readNumber(
  record: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const value = Number(record[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

export function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "y" || text === "on";
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
