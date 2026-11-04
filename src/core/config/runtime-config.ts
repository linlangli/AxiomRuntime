import { getRuntimeConfigPath } from "./paths.js";
import { readJsonFile, updateJsonFile } from "./json-store.js";
import { normalizeProxyUrl } from "../network/proxy.js";
import { readBoolean } from "./schema.js";

export type RuntimeConfig = {
  proxyUrl?: string;
  /** 为 true 时关闭 Provider 自动降级切换：失败只报错，不轮转到下一个候选。 */
  failoverDisabled?: boolean;
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

export async function setRuntimeFailover(disabled: boolean): Promise<RuntimeConfig> {
  return updateJsonFile<RuntimeConfig>(getRuntimeConfigPath(), {}, (current) => {
    const { failoverDisabled: _previous, ...rest } = current;
    return disabled ? { ...rest, failoverDisabled: true } : rest;
  });
}

export function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const proxyUrl = record.proxyUrl;
  const normalized = typeof proxyUrl === "string" && proxyUrl.trim()
    ? normalizeProxyUrl(proxyUrl)
    : undefined;
  const failoverDisabled = readBoolean(record.failoverDisabled);
  const config: RuntimeConfig = {};
  if (normalized) config.proxyUrl = normalized;
  if (failoverDisabled) config.failoverDisabled = true;
  return config;
}
