import { getRuntimeConfigPath } from "./paths.js";
import { readJsonFile, updateJsonFile } from "./json-store.js";
import { normalizeProxyUrl } from "../network/proxy.js";

export type RuntimeConfig = {
  proxyUrl?: string;
};

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const raw = await readJsonFile<unknown>(getRuntimeConfigPath(), {});
  return normalizeRuntimeConfig(raw);
}

export async function setRuntimeProxy(proxyUrl: string | null): Promise<RuntimeConfig> {
  return updateJsonFile<RuntimeConfig>(getRuntimeConfigPath(), {}, (current) => {
    const { proxyUrl: _previousProxy, ...rest } = current;
    if (!proxyUrl) {
      return rest;
    }
    return { ...rest, proxyUrl: normalizeProxyUrl(proxyUrl) ?? undefined };
  });
}

export function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const proxyUrl = (value as Record<string, unknown>).proxyUrl;
  if (typeof proxyUrl !== "string" || !proxyUrl.trim()) return {};
  const normalized = normalizeProxyUrl(proxyUrl);
  return normalized ? { proxyUrl: normalized } : {};
}
