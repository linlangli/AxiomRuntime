import { getCachePath } from "./paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json-store.js";
import type { CacheFile, CliToolType, ProviderCache } from "../types.js";

const EMPTY_CACHE: CacheFile = { providers: {} };

export async function readCache(): Promise<CacheFile> {
  const cache = await readJsonFile<CacheFile>(getCachePath(), EMPTY_CACHE);
  return normalizeCache(cache);
}

export async function writeCache(cache: CacheFile): Promise<void> {
  await writeJsonFile(getCachePath(), normalizeCache(cache));
}

export async function upsertProviderCache(providerName: string, providerCache: ProviderCache): Promise<void> {
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => {
    const next = normalizeCache(cache);
    next.providers[providerName] = providerCache;
    return next;
  });
}

export async function renameProviderCache(from: string, to: string): Promise<void> {
  if (from === to) return;
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => {
    const next = normalizeCache(cache);
    if (next.providers[from]) {
      next.providers[to] = next.providers[from];
      delete next.providers[from];
    }
    if (next.lastSelection?.provider === from) {
      next.lastSelection.provider = to;
    }
    return next;
  });
}

export async function deleteProviderCache(providerName: string): Promise<void> {
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => {
    const next = normalizeCache(cache);
    delete next.providers[providerName];
    if (next.lastSelection?.provider === providerName) {
      delete next.lastSelection;
    }
    return next;
  });
}

export async function saveLastSelection(tool: CliToolType, provider: string, model: string): Promise<void> {
  await updateJsonFile(getCachePath(), EMPTY_CACHE, (cache) => ({
    ...normalizeCache(cache),
    lastSelection: {
      tool,
      provider,
      model,
      usedAt: new Date().toISOString()
    }
  }));
}

function normalizeCache(cache: CacheFile): CacheFile {
  return {
    providers: cache.providers ?? {},
    lastSelection: cache.lastSelection
  };
}
