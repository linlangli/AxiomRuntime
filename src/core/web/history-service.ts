import { readRecentLogs } from "../logs/log-service.js";
import { readSessions } from "../config/session-store.js";
import { readUsage } from "../config/usage-store.js";
import { projectHistoryLogs, summarizeCalls } from "./execution-history.js";
import { SettingsInputError } from "../config/service-exposure.js";

export async function queryWebHistory(input: URLSearchParams) {
  const kind = input.get("kind") || "logs";
  if (!["logs", "calls", "sessions", "usage"].includes(kind)) throw new SettingsInputError("历史记录类型无效。");
  const limit = Number(input.get("limit") || 100);
  const offset = Number(input.get("offset") || 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new SettingsInputError("分页参数无效。");
  const sessions = (await readSessions()).sessions.map(({ id, tool, provider, model, startedAt, endedAt, status, exitCode }) => ({ id, tool, provider, model, startedAt, endedAt, status, exitCode }));
  let items: object[];
  if (kind === "usage") items = (await readUsage()).events.map(({ createdAt, provider, model, inputTokens, outputTokens, totalTokens }) => ({ createdAt, provider, model, inputTokens, outputTokens, totalTokens })).reverse();
  else if (kind === "sessions") items = sessions.reverse();
  else {
    const logs = projectHistoryLogs(await readRecentLogs(Number.MAX_SAFE_INTEGER));
    items = kind === "calls" ? summarizeCalls(logs, new Set(sessions.map(item => item.id))) : logs.reverse();
  }
  const provider = input.get("provider");
  const query = input.get("q")?.toLowerCase();
  const before = input.get("before");
  const since = input.get("since");
  const filtered = items.filter(item => {
    const row = item as Record<string, unknown>;
    const time = String(row.timestamp ?? row.startedAt ?? row.createdAt ?? "");
    return (!provider || row.provider === provider) && (!query || JSON.stringify(row).toLowerCase().includes(query)) && (!before || time <= before) && (!since || time >= since);
  });
  return { kind, total: filtered.length, offset, items: filtered.slice(offset, offset + limit), nextOffset: offset + limit < filtered.length ? offset + limit : null };
}

export function historyCsv(items: object[]) {
  const fields = [...new Set(items.flatMap(item => Object.keys(item)))];
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return "\ufeff" + [fields.map(cell).join(","), ...items.map(item => fields.map(field => cell((item as Record<string, unknown>)[field])).join(","))].join("\r\n");
}
