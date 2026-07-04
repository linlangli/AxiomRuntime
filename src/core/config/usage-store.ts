import { getUsagePath } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { UsageEvent, UsageFile } from "../types.js";

export async function readUsage(): Promise<UsageFile> {
  const usage = await readJsonFile<UsageFile>(getUsagePath(), { events: [] });
  return { events: Array.isArray(usage.events) ? usage.events : [] };
}

export async function appendUsageEvent(event: UsageEvent): Promise<void> {
  const usage = await readUsage();
  usage.events.push(event);
  await writeJsonFile(getUsagePath(), usage);
}

export async function ensureUsageFile(): Promise<void> {
  const usage = await readUsage();
  await writeJsonFile(getUsagePath(), usage);
}
