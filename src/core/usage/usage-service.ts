import { readUsage } from "../config/usage-store.js";
import type { UsageEvent } from "../types.js";

export async function getWeeklyTokenMap(): Promise<Map<string, number>> {
  const usage = await readUsage();
  const start = getWeekStart(new Date());
  const map = new Map<string, number>();

  for (const event of usage.events) {
    if (new Date(event.createdAt) >= start) {
      map.set(event.provider, (map.get(event.provider) ?? 0) + event.totalTokens);
    }
  }

  return map;
}

export function getUsageShare(providerTokens: number, allTokens: number): number {
  if (!allTokens) return 0;
  return Number(((providerTokens / allTokens) * 100).toFixed(2));
}

export function buildUsageEvent(input: Omit<UsageEvent, "createdAt">): UsageEvent {
  return {
    ...input,
    createdAt: new Date().toISOString()
  };
}

function getWeekStart(date: Date): Date {
  const start = new Date(date);
  const day = start.getDay() || 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - day + 1);
  return start;
}
