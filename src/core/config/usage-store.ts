import { getUsagePath } from "./paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json-store.js";
import type { UsageEvent, UsageFile } from "../types.js";

export async function readUsage(): Promise<UsageFile> {
  const usage = await readJsonFile<UsageFile>(getUsagePath(), { events: [] });
  return normalizeUsageFile(usage);
}

export async function appendUsageEvent(event: UsageEvent): Promise<void> {
  await updateJsonFile<UsageFile>(getUsagePath(), { events: [] }, (usage) => ({
    events: [...normalizeUsageFile(usage).events, event]
  }));
}

export async function ensureUsageFile(): Promise<void> {
  const usage = await readUsage();
  await writeJsonFile(getUsagePath(), usage);
}

function normalizeUsageFile(usage: UsageFile): UsageFile {
  return { events: Array.isArray(usage.events) ? usage.events : [] };
}
