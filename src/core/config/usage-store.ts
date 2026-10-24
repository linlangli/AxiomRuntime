import { getUsagePath } from "./paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json-store.js";
import type { UsageEvent, UsageFile } from "../types.js";
import { appendDatabaseUsage, databaseItems, readHistoryDatabase, updateHistoryDatabase } from "./history-database.js";

export async function readUsage(): Promise<UsageFile> {
  return readHistoryDatabase(async database => database ? { events: databaseItems<UsageEvent>(database, "usage") }
    : normalizeUsageFile(await readJsonFile<UsageFile>(getUsagePath(), { events: [] })));
}

export async function appendUsageEvent(event: UsageEvent): Promise<void> {
  await appendUsageEvents([event]);
}

export async function appendUsageEvents(events: UsageEvent[]): Promise<number> {
  if (!events.length) return 0;
  return updateHistoryDatabase(async database => {
    if (database) return appendDatabaseUsage(database, events);
    let appended = 0;
    await updateJsonFile<UsageFile>(getUsagePath(), { events: [] }, (usage) => {
      const existing = normalizeUsageFile(usage).events;
      const identities = new Set(existing.flatMap(event => event.id ? [event.id] : []));
      const additions = events.filter(event => {
        if (event.id && identities.has(event.id)) return false;
        if (event.id) identities.add(event.id);
        return true;
      });
      appended = additions.length;
      return { events: [...existing, ...additions] };
    });
    return appended;
  });
}

export async function ensureUsageFile(): Promise<void> {
  await updateHistoryDatabase(async database => {
    if (!database) await writeJsonFile(getUsagePath(), normalizeUsageFile(await readJsonFile<UsageFile>(getUsagePath(), { events: [] })));
  });
}

function normalizeUsageFile(usage: UsageFile): UsageFile {
  return { events: Array.isArray(usage.events) ? usage.events : [] };
}
