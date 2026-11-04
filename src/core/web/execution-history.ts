import type { LogEvent } from "../types.js";

export type HistoryCategory = "model" | "check" | "config" | "system";

const successes = new Set(["tool_run_settled", "runtime_provider_settled", "task_completed"]);
const failures = new Set(["tool_candidates_exhausted", "runtime_provider_candidates_exhausted", "runtime_server_candidates_exhausted", "runtime_server_request_failed", "provider_candidates_unavailable", "task_failed"]);
const switches = new Set(["fallback_applied", "runtime_fallback_retry", "runtime_provider_fallback_retry", "runtime_server_provider_fallback", "provider_failover_automatic", "provider_failover_manual"]);
const checks = new Set(["provider_health_check", "provider_model_discovery", "provider_model_probe", "deep_fallback", "token_usage_recorded"]);

function historyCategory(event: LogEvent): HistoryCategory {
  if (checks.has(event.action)) return "check";
  if (/^(web_settings_|web_model_pricing_|codex_provider_set$|codex_proxy_set$|codex_usage_configured$)/.test(event.action)) return "config";
  if (successes.has(event.action) || failures.has(event.action) || switches.has(event.action) ||
      /^(provider_resolved|provider_retry$|provider_failover_|fallback_skip_provider$|failover_disabled$|tool_start$|tool_spawn$|claude_start$|codex_start$|openai_usage_proxy_|runtime_server_request_settled$|image_generat)/.test(event.action)) return "model";
  return "system";
}

export function projectHistoryLogs(logs: LogEvent[]) {
  return logs.map(event => {
    const metadata = event.metadata;
    const text = (key: string) => typeof metadata?.[key] === "string" ? metadata[key] as string : null;
    const number = (key: string) => typeof metadata?.[key] === "number" && Number.isFinite(metadata[key]) ? metadata[key] as number : null;
    return {
      timestamp: event.timestamp, level: event.level, category: event.category, action: event.action,
      traceId: event.traceId || null, kind: historyCategory(event),
      provider: text("provider"), model: text("model"), tool: text("tool") ?? text("engine"),
      status: text("status") ?? number("status"), attempt: number("attempt"), durationMs: number("durationMs"),
      exitCode: number("exitCode"), sessionId: text("sessionId"), executionId: text("executionId"), outcome: text("outcome"),
      inputTokens: number("inputTokens"), outputTokens: number("outputTokens"), totalTokens: number("totalTokens"),
      costUsd: number("costUsd"), costSource: text("costSource"),
      modelInvocation: typeof metadata?.modelInvocation === "boolean" ? metadata.modelInvocation : null,
      from: text("from"), to: text("to"),
      reason: text("reason")?.match(/^[a-z_]{1,60}$/)?.[0] ?? null
    };
  });
}

type HistoryLog = ReturnType<typeof projectHistoryLogs>[number];

function terminalResult(event: HistoryLog): "succeeded" | "failed" | null {
  if (failures.has(event.action)) return "failed";
  if (event.action === "openai_usage_proxy_request_settled") return event.outcome === "succeeded" ? "succeeded" : event.outcome === "failed" ? "failed" : null;
  if (event.action === "runtime_server_request_settled") {
    const status = Number(event.status);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status >= 200 && status < 400 ? "succeeded" : "failed" : null;
  }
  if (successes.has(event.action)) return "succeeded";
  return null;
}

export function summarizeCalls(logs: HistoryLog[], knownSessionIds: ReadonlySet<string> = new Set()) {
  const groups = new Map<string, HistoryLog[]>();
  for (const event of logs) {
    if (!event.traceId) continue;
    const group = groups.get(event.traceId) ?? [];
    group.push(event);
    groups.set(event.traceId, group);
  }
  return [...groups.entries()].filter(([, events]) => events.some(event => event.kind === "model") && !events.some(event => event.action === "openai_usage_proxy_request" && event.modelInvocation === false)).map(([id, group]) => {
    const events = [...group].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const terminal = [...events].reverse().find(event => terminalResult(event) !== null);
    const route: string[] = [];
    const appendProvider = (provider: string | null) => {
      if (provider && route.at(-1) !== provider) route.push(provider);
    };
    let pendingSwitch: { from: string | null; to: string | null } | null = null;
    let switchCount = 0;
    for (const event of events) {
      if (switches.has(event.action)) {
        const duplicateApplied = event.action === "fallback_applied" && pendingSwitch?.from === event.from && pendingSwitch?.to === event.to;
        if (!duplicateApplied) {
          if (!event.from || !event.to || event.from !== event.to) switchCount += 1;
          appendProvider(event.from ?? event.provider);
          appendProvider(event.to);
        }
        pendingSwitch = event.action === "runtime_fallback_retry" ? { from: event.from, to: event.to } : null;
      } else if (event.action !== "fallback_skip_provider") {
        appendProvider(event.provider);
      }
    }
    const first = events[0]!;
    const last = events.at(-1)!;
    const span = Date.parse(last.timestamp) - Date.parse(first.timestamp);
    const usage = events.filter(event => event.action === "openai_usage_proxy_recorded");
    const sum = (field: "inputTokens" | "outputTokens" | "totalTokens" | "costUsd") => usage.length && usage.every(event => event[field] !== null)
      ? usage.reduce((total, event) => total + event[field]!, 0) : null;
    return {
      id, state: terminal ? terminalResult(terminal)! : "unknown" as const,
      startedAt: first.timestamp, lastEventAt: last.timestamp, endedAt: terminal?.timestamp ?? null,
      durationMs: terminal?.durationMs ?? null,
      observedDurationMs: events.length > 1 && Number.isFinite(span) && span >= 0 ? span : null,
      provider: terminal?.provider ?? null, initialProvider: route[0] ?? null,
      model: terminal?.model ?? [...events].reverse().find(event => event.model)?.model ?? null,
      tool: events.find(event => event.tool)?.tool ?? null, executionId: events.find(event => event.executionId)?.executionId ?? null,
      inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens"), costUsd: sum("costUsd"),
      costSource: usage.length === 1 ? usage[0]!.costSource : null,
      route, switchCount, retryCount: events.filter(event => event.action === "provider_retry").length,
      sessionIds: [...new Set(events.flatMap(event => event.sessionId && knownSessionIds.has(event.sessionId) ? [event.sessionId] : []))],
      events
    };
  }).sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
}
