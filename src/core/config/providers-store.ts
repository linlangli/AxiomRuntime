import { getProvidersPath } from "./paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json-store.js";
import { readNumber, readOptionalRecord, readOptionalString, readRecord, readString } from "./schema.js";
import { normalizeProxyUrl } from "../network/proxy.js";
import type { Provider, ProviderAuthScheme, ProviderMode, ProviderRequestProfile } from "../types.js";

const VALID_MODES = new Set<ProviderMode>(["ask", "auto"]);
const VALID_AUTH_SCHEMES = new Set<ProviderAuthScheme>(["bearer", "x-api-key", "api-key"]);

export async function readProviders(): Promise<Provider[]> {
  const raw = await readJsonFile<unknown>(getProvidersPath(), []);
  if (!Array.isArray(raw)) {
    throw new Error("providers.json must contain a JSON array.");
  }
  return normalizeProviders(raw.map(normalizeProviderShape));
}

export async function writeProviders(providers: Provider[]): Promise<void> {
  await writeJsonFile(getProvidersPath(), normalizeProviders(providers));
}

export async function updateProviders(updater: (providers: Provider[]) => Provider[] | Promise<Provider[]>): Promise<Provider[]> {
  return updateJsonFile<Provider[]>(getProvidersPath(), [], async (raw) => {
    if (!Array.isArray(raw)) {
      throw new Error("providers.json must contain a JSON array.");
    }
    return normalizeProviders(await updater(normalizeProviders(raw.map(normalizeProviderShape))));
  });
}

export function normalizeProviders(providers: Provider[]): Provider[] {
  const seenNames = new Set<string>();
  const validated = providers.map((provider) => {
    const name = provider.name.trim();
    if (!name) {
      throw new Error("Provider name cannot be empty.");
    }
    if (seenNames.has(name)) {
      throw new Error(`Duplicate provider name: ${name}`);
    }
    seenNames.add(name);

    const baseUrl = provider.baseUrl.trim().replace(/\/+$/, "");
    const apiKey = provider.apiKey.trim();
    if (!baseUrl) {
      throw new Error(`Provider ${name} baseUrl cannot be empty.`);
    }
    if (!apiKey) {
      throw new Error(`Provider ${name} apiKey cannot be empty.`);
    }

    return {
      name,
      baseUrl,
      apiKey,
      mode: VALID_MODES.has(provider.mode) ? provider.mode : "auto",
      level: Number.isInteger(provider.level) && provider.level > 0 ? provider.level : 0,
      model: provider.model.trim(),
      ...(provider.proxyUrl?.trim() ? { proxyUrl: provider.proxyUrl.trim() } : {}),
      ...(provider.requestProfile ? { requestProfile: normalizeRequestProfile(provider.requestProfile) } : {})
    };
  });

  const active = validated
    .filter((provider) => provider.level > 0)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
    .map((provider, index) => ({ ...provider, level: index + 1 }));
  const excluded = validated
    .filter((provider) => provider.level === 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...active, ...excluded];
}

export function swapProviderLevel(providers: Provider[], providerName: string, targetLevel: number): Provider[] {
  const normalized = normalizeProviders(providers);
  const source = normalized.find((provider) => provider.name === providerName);
  if (!source) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  if (!Number.isInteger(targetLevel) || targetLevel < 0) {
    throw new Error(`Invalid level: ${targetLevel}`);
  }

  if (targetLevel === 0) {
    return normalizeProviders(normalized.map((provider) =>
      provider.name === source.name ? { ...provider, level: 0 } : provider
    ));
  }

  const activeCount = normalized.filter((provider) => provider.level > 0).length;
  const maxTargetLevel = activeCount + (source.level === 0 ? 1 : 0);
  if (targetLevel > maxTargetLevel) throw new Error(`Invalid level: ${targetLevel}`);

  const target = normalized.find((provider) => provider.level === targetLevel);
  if (!target) {
    return normalizeProviders(normalized.map((provider) =>
      provider.name === source.name ? { ...provider, level: targetLevel } : provider
    ));
  }

  const sourceLevel = source.level > 0 ? source.level : activeCount + 1;
  return normalizeProviders(
    normalized.map((provider) => {
      if (provider.name === source.name) {
        return { ...provider, level: targetLevel };
      }
      if (provider.name === target.name) {
        return { ...provider, level: sourceLevel };
      }
      return provider;
    })
  );
}

function normalizeProviderShape(value: unknown): Provider {
  const provider = readRecord(value, "provider");
  const mode = readString(provider, "mode");
  const requestProfile = readOptionalRecord(provider.requestProfile, "provider.requestProfile");
  const proxyUrl = readOptionalString(provider, "proxyUrl");
  const normalizedProxyUrl = proxyUrl ? normalizeProviderProxyShape(proxyUrl) : undefined;
  return {
    name: readString(provider, "name"),
    baseUrl: readString(provider, "baseUrl"),
    apiKey: readString(provider, "apiKey"),
    mode: mode === "ask" ? "ask" : "auto",
    level: readNumber(provider, "level", Number.MAX_SAFE_INTEGER),
    model: readString(provider, "model"),
    ...(normalizedProxyUrl ? { proxyUrl: normalizedProxyUrl } : {}),
    ...(requestProfile ? { requestProfile: normalizeRequestProfileShape(requestProfile) } : {})
  };
}

// providers.json 是人类可编辑文件：无效 proxyUrl 静默丢弃而不是让 readProviders() 整体失败，
// 与 mode/level 的宽松归一化先例一致。
function normalizeProviderProxyShape(value: string): string | undefined {
  try {
    return normalizeProxyUrl(value) ?? undefined;
  } catch {
    return undefined;
  }
}

function normalizeRequestProfileShape(value: Record<string, unknown>): ProviderRequestProfile {
  const verifiedProtocols = Array.isArray(value.verifiedProtocols)
    ? value.verifiedProtocols.filter((item): item is "openai" | "anthropic" => item === "openai" || item === "anthropic")
    : [];
  return normalizeRequestProfile({
    discoveryAuth: normalizeAuthScheme(value.discoveryAuth, "bearer"),
    openaiAuth: normalizeAuthScheme(value.openaiAuth, "bearer"),
    anthropicAuth: normalizeAuthScheme(value.anthropicAuth, "x-api-key"),
    verifiedProtocols
  });
}

function normalizeRequestProfile(value: ProviderRequestProfile): ProviderRequestProfile {
  return {
    discoveryAuth: normalizeAuthScheme(value.discoveryAuth, "bearer"),
    openaiAuth: normalizeAuthScheme(value.openaiAuth, "bearer"),
    anthropicAuth: normalizeAuthScheme(value.anthropicAuth, "x-api-key"),
    verifiedProtocols: [...new Set(value.verifiedProtocols.filter((item) => item === "openai" || item === "anthropic"))]
  };
}

function normalizeAuthScheme(value: unknown, fallback: ProviderAuthScheme): ProviderAuthScheme {
  return VALID_AUTH_SCHEMES.has(value as ProviderAuthScheme) ? value as ProviderAuthScheme : fallback;
}
