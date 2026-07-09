import { getProvidersPath } from "./paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json-store.js";
import type { Provider, ProviderMode } from "../types.js";

const VALID_MODES = new Set<ProviderMode>(["ask", "auto"]);

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
  const sorted = [...providers].sort((a, b) => {
    const aLevel = Number.isFinite(a.level) && a.level > 0 ? a.level : Number.MAX_SAFE_INTEGER;
    const bLevel = Number.isFinite(b.level) && b.level > 0 ? b.level : Number.MAX_SAFE_INTEGER;
    return aLevel - bLevel || a.name.localeCompare(b.name);
  });

  const seenNames = new Set<string>();
  return sorted.map((provider, index) => {
    const name = provider.name.trim();
    if (!name) {
      throw new Error("Provider name cannot be empty.");
    }
    if (seenNames.has(name)) {
      throw new Error(`Duplicate provider name: ${name}`);
    }
    seenNames.add(name);

    return {
      name,
      baseUrl: provider.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: provider.apiKey.trim(),
      mode: VALID_MODES.has(provider.mode) ? provider.mode : "auto",
      level: index + 1,
      model: provider.model.trim()
    };
  });
}

export function swapProviderLevel(providers: Provider[], providerName: string, targetLevel: number): Provider[] {
  const normalized = normalizeProviders(providers);
  const source = normalized.find((provider) => provider.name === providerName);
  if (!source) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  const target = normalized.find((provider) => provider.level === targetLevel);
  if (!target) {
    throw new Error(`Invalid level: ${targetLevel}`);
  }

  const sourceLevel = source.level;
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
  const provider = value as Partial<Provider>;
  return {
    name: String(provider.name ?? ""),
    baseUrl: String(provider.baseUrl ?? ""),
    apiKey: String(provider.apiKey ?? ""),
    mode: provider.mode === "ask" ? "ask" : "auto",
    level: Number(provider.level ?? Number.MAX_SAFE_INTEGER),
    model: String(provider.model ?? "")
  };
}
