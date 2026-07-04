import { getCachePath } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { CacheFile, ProviderCache, ToolType } from "../types.js";

const EMPTY_CACHE: CacheFile = { providers: {} };

export async function readCache(): Promise<CacheFile> {
  const cache = await readJsonFile<CacheFile>(getCachePath(), EMPTY_CACHE);
  return {
    providers: cache.providers ?? {},
    lastSelection: cache.lastSelection
  };
}

export async function writeCache(cache: CacheFile): Promise<void> {
  await writeJsonFile(getCachePath(), { providers: cache.providers ?? {}, lastSelection: cache.lastSelection });
}

export async function upsertProviderCache(providerName: string, providerCache: ProviderCache): Promise<void> {
  const cache = await readCache();
  cache.providers[providerName] = providerCache;
  await writeCache(cache);
}

export async function renameProviderCache(from: string, to: string): Promise<void> {
  if (from === to) return;
  const cache = await readCache();
  if (cache.providers[from]) {
    cache.providers[to] = cache.providers[from];
    delete cache.providers[from];
  }
  if (cache.lastSelection?.provider === from) {
    cache.lastSelection.provider = to;
  }
  await writeCache(cache);
}

export async function saveLastSelection(tool: ToolType, provider: string, model: string): Promise<void> {
  const cache = await readCache();
  cache.lastSelection = {
    tool,
    provider,
    model,
    usedAt: new Date().toISOString()
  };
  await writeCache(cache);
}
