import { iterateLogsNewestFirst, readRecentLogs } from "../logs/log-service.js";
import { readSessions } from "../config/session-store.js";
import { readUsage } from "../config/usage-store.js";
import { projectHistoryLogs, summarizeCalls } from "./execution-history.js";
import { SettingsInputError } from "../config/service-exposure.js";
import { queryDatabaseHistory } from "../config/history-database.js";
import type { SessionRecord, UsageEvent } from "../types.js";

function projectSession({ id, tool, provider, model, startedAt, endedAt, status, exitCode, actualProvider, actualModel, nativeSessionId, traceId, resumedFrom }: SessionRecord) {
  return { id, tool, provider, model, startedAt, endedAt, status, exitCode, actualProvider, actualModel, nativeSessionId, traceId, resumedFrom };
}

function projectUsage({ id, createdAt, provider, model, inputTokens, outputTokens, totalTokens, sessionId, traceId, costUsd, costSource }: UsageEvent) {
  return { id, createdAt, provider, model, inputTokens, outputTokens, totalTokens, sessionId, traceId, costUsd, costSource };
}

export async function queryWebHistory(input: URLSearchParams) {
  const kind = input.get("kind") || "logs";
  if (!["logs", "calls", "sessions", "usage"].includes(kind)) throw new SettingsInputError("历史记录类型无效。");
  const limit = Number(input.get("limit") || 100);
  const offset = Number(input.get("offset") || 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new SettingsInputError("分页参数无效。");
  const matches = (row: Record<string, unknown>) => {
    const time = String(row.timestamp ?? row.startedAt ?? row.createdAt ?? "");
    const provider = input.get("provider");
    const query = input.get("q")?.toLowerCase();
    return (!provider || row.provider === provider || row.actualProvider === provider) && (!query || JSON.stringify(row).toLowerCase().includes(query)) && (!input.get("before") || time <= input.get("before")!) && (!input.get("since") || time >= input.get("since")!);
  };
  if (kind === "logs") {
    let total = 0;
    const items: object[] = [];
    for await (const event of iterateLogsNewestFirst()) {
      const row = projectHistoryLogs([event])[0]!;
      if (!matches(row)) continue;
      if (total >= offset && items.length < limit) items.push(row);
      total += 1;
    }
    return { kind, total, offset, items, nextOffset: offset + limit < total ? offset + limit : null };
  }
  if (kind === "usage" || kind === "sessions") {
    const result = await queryDatabaseHistory(kind, input, limit, offset);
    if (result) return { kind, total: result.total, offset, items: result.items.map(item => kind === "sessions" ? projectSession(item) : projectUsage(item)), nextOffset: offset + limit < result.total ? offset + limit : null };
  }
  const sessions = (await readSessions()).sessions.map(projectSession);
  let items: object[];
  if (kind === "usage") items = (await readUsage()).events.map(projectUsage).reverse();
  else if (kind === "sessions") items = sessions.reverse();
  else {
    const logs = projectHistoryLogs(await readRecentLogs(Number.MAX_SAFE_INTEGER));
    items = kind === "calls" ? summarizeCalls(logs, new Set(sessions.map(item => item.id))) : logs.reverse();
  }
  const filtered = items.filter(item => matches(item as Record<string, unknown>));
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
