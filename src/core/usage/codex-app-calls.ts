import crypto from "node:crypto";
import type { CodexNativeSource } from "../integrations/codex-session-source.js";
import type { TokenUsage } from "../types.js";
import { isRecord } from "../utils/is-record.js";
import { projectHistoryLogs, summarizeCalls } from "../web/execution-history.js";

export type NativeTurn = { id: string; startedAt: string; lastEventAt: string; endedAt: string | null; state: "succeeded" | "failed" | "unknown"; model: string | null; initialProvider: string | null; durationMs: number | null; terminal: string | null; usage?: TokenUsage; contextConfirmed?: boolean };
export type NativeCursor = { sessionId?: string; providerId?: string; source?: CodexNativeSource | false; desktop?: boolean; turns?: NativeTurn[] };
const name = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function validNativeTurn(value: unknown): value is NativeTurn {
  return isRecord(value) && name(value.id) && time(value.startedAt) && time(value.lastEventAt)
    && (value.endedAt === null || time(value.endedAt)) && ["succeeded", "failed", "unknown"].includes(String(value.state))
    && (value.model === null || name(value.model)) && (value.initialProvider === null || name(value.initialProvider))
    && (value.durationMs === null || (typeof value.durationMs === "number" && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0))
    && (value.usage === undefined || (isRecord(value.usage) && [value.usage.inputTokens, value.usage.outputTokens, value.usage.totalTokens].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) && value.usage.totalTokens === Number(value.usage.inputTokens) + Number(value.usage.outputTokens)))
    && (value.terminal === null || ["task_complete", "turn_aborted"].includes(String(value.terminal)));
}

export function collectNativeTurn(cursor: NativeCursor, event: Record<string, unknown>, enabledAt: string) {
  if (!isRecord(event.payload) || !time(event.timestamp) || Date.parse(event.timestamp) < Date.parse(enabledAt) || Date.parse(event.timestamp) > Date.now() + 300_000) return;
  const p = event.payload;
  if (!name(p.turn_id)) return;
  if (event.type === "event_msg" && p.type === "task_started") {
    const turns = cursor.turns ??= [];
    if (turns.some(turn => turn.id === p.turn_id)) return;
    turns.push({ id: p.turn_id, startedAt: event.timestamp, lastEventAt: event.timestamp, endedAt: null, state: "unknown", model: null, initialProvider: cursor.providerId ?? null, durationMs: null, terminal: null });
    if (turns.length > 30) turns.splice(0, turns.length - 30);
    return;
  }
  const turn = cursor.turns?.find(turn => turn.id === p.turn_id);
  if (!turn || event.timestamp < turn.startedAt) return;
  if (event.type === "turn_context" && !turn.endedAt) {
    if (name(p.model)) { turn.model = p.model; turn.contextConfirmed = true; }
  } else if (event.type === "event_msg" && ["task_complete", "turn_aborted"].includes(String(p.type)) && !turn.endedAt) {
    turn.lastEventAt = event.timestamp; turn.endedAt = event.timestamp; turn.terminal = String(p.type);
    // Native completion is a task outcome, not an HTTP/model-request result.
    turn.state = p.type === "task_complete" ? p.error == null ? "succeeded" : p.error ? "failed" : "unknown" : "unknown";
    if (typeof p.duration_ms === "number" && Number.isSafeInteger(p.duration_ms) && p.duration_ms >= 0) turn.durationMs = p.duration_ms;
  }
}

export function collectNativeUsage(cursor: NativeCursor, usage: TokenUsage, timestamp: string) {
  const open = cursor.turns?.filter(turn => !turn.endedAt) ?? [];
  if (open.length !== 1 || !open[0]!.contextConfirmed || timestamp < open[0]!.startedAt) return;
  const turn = open[0]!;
  const previous = turn.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0 };
  const next = { inputTokens: previous.inputTokens + usage.inputTokens, outputTokens: previous.outputTokens + usage.outputTokens, totalTokens: previous.totalTokens + usage.totalTokens, cacheReadInputTokens: (previous.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) };
  if (!Object.values(next).every(Number.isSafeInteger)) return;
  turn.usage = next; turn.lastEventAt = timestamp;
}

export function projectNativeTurns(home: string, cursors: NativeCursor[]) {
  const calls = new Map<string, Omit<ReturnType<typeof summarizeCalls>[number], "initialProvider"> & { source: CodexNativeSource; initialProvider: string | null }>();
  for (const cursor of cursors) {
    const source = cursor.source ?? (cursor.desktop === true ? "codex_app" : false);
    if (!source || !cursor.sessionId || !Array.isArray(cursor.turns)) continue;
    for (const turn of cursor.turns) {
      if (!validNativeTurn(turn)) continue;
      const hash = crypto.createHash("sha256").update(JSON.stringify([home, cursor.sessionId, turn.id])).digest("hex");
      const id = `${source}_turn:${hash}`;
      const events = projectHistoryLogs([
        { timestamp: turn.startedAt, level: "info", category: "system", action: `${source}_task_started`, message: "", traceId: id },
        ...(turn.endedAt ? [{ timestamp: turn.endedAt, level: "info" as const, category: "system" as const,
          action: `${source}_${turn.terminal === "turn_aborted" ? "turn_aborted" : "task_complete"}`, message: "", traceId: id }] : [])
      ]);
      const call = {
        id, source, state: turn.state, startedAt: turn.startedAt, lastEventAt: turn.lastEventAt, endedAt: turn.endedAt,
        durationMs: turn.durationMs, observedDurationMs: turn.endedAt ? Date.parse(turn.endedAt) - Date.parse(turn.startedAt) : null,
        provider: null, initialProvider: turn.initialProvider, model: turn.model, tool: "codex", executionId: null,
        inputTokens: turn.usage?.inputTokens ?? null, outputTokens: turn.usage?.outputTokens ?? null, totalTokens: turn.usage?.totalTokens ?? null,
        costUsd: null, costSource: null, route: turn.initialProvider ? [turn.initialProvider] : [], switchCount: 0, retryCount: 0, sessionIds: [], events
      };
      const previous = calls.get(id);
      if (!previous || previous.lastEventAt < call.lastEventAt || (!previous.endedAt && call.endedAt)) calls.set(id, call);
    }
  }
  return [...calls.values()].sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt)).slice(0, 100);
}
