import assert from "node:assert/strict";
import test from "node:test";
import { projectHistoryLogs, summarizeCalls } from "../dist/core/web/execution-history.js";

function event(action, metadata = {}, options = {}) {
  return { timestamp: "2026-10-16T10:00:00.000Z", level: "info", category: "strategy", message: "private message", traceId: "trc_test", action, metadata, ...options };
}
function summarize(events, sessions) { return summarizeCalls(projectHistoryLogs(events), sessions); }

test("history projection preserves HTTP results and excludes arbitrary metadata and messages", () => {
  const [safe] = projectHistoryLogs([event("runtime_server_request_settled", {
    provider: "first", model: "model-a", status: 503, tool: "codex", durationMs: 250,
    apiKey: "secret-api-key", requestBody: "private request", error: "private error", reason: "private credential: secret"
  })]);
  assert.equal(safe.status, 503);
  assert.equal(safe.durationMs, 250);
  assert.equal(safe.kind, "model");
  assert.equal(safe.reason, null);
  assert.doesNotMatch(JSON.stringify(safe), /private|secret|apiKey|requestBody/);
});

test("unlinked events and configuration traces remain logs without becoming calls", () => {
  const events = [event("openai_usage_proxy_request", { provider: "first" }, { traceId: undefined }), event("web_settings_updated"), event("provider_health_check"), event("bot_start"), event("web_model_pricing_updated")];
  assert.equal(summarize(events).length, 0);
  assert.deepEqual(projectHistoryLogs(events).map(item => item.kind), ["model", "config", "check", "system", "config"]);
});

test("missing terminal events produce unknown results without guessing a final Provider or duration", () => {
  const [call] = summarize([event("tool_start", { provider: "first", tool: "codex", model: "gpt-test" }), event("openai_usage_proxy_error", { provider: "second" }, { level: "error", timestamp: "2026-10-16T10:00:02.000Z" })]);
  assert.equal(call.state, "unknown");
  assert.equal(call.provider, null);
  assert.equal(call.endedAt, null);
  assert.equal(call.durationMs, null);
  assert.equal(call.observedDurationMs, 2000);
  assert.equal(call.initialProvider, "first");
});

test("retry and switch counts differ, paired switch events count once, and routes retain return hops", () => {
  const [call] = summarize([
    event("tool_start", { provider: "first" }), event("provider_retry", { provider: "first", attempt: 2 }),
    event("runtime_fallback_retry", { from: "first", to: "second" }), event("fallback_applied", { from: "first", to: "second" }),
    event("tool_start", { provider: "second" }), event("runtime_fallback_retry", { from: "second", to: "first" }),
    event("fallback_applied", { from: "second", to: "first" }), event("tool_run_settled", { provider: "first" })
  ]);
  assert.equal(call.retryCount, 1);
  assert.equal(call.switchCount, 2);
  assert.deepEqual(call.route, ["first", "second", "first"]);
  assert.equal(call.state, "succeeded");
  assert.equal(call.provider, "first");
});

test("skipped candidates and protocol compatibility fallbacks do not become Provider switches", () => {
  const [call] = summarize([
    event("fallback_skip_provider", { provider: "skipped", reason: "circuit_open" }),
    event("tool_start", { provider: "first" }), event("openai_usage_proxy_responses_chat_fallback", { provider: "first" }),
    event("provider_failover_automatic", { from: "first", to: "first" }), event("tool_run_settled", { provider: "first" })
  ]);
  assert.deepEqual(call.route, ["first"]);
  assert.equal(call.switchCount, 0);
  assert.equal(call.retryCount, 0);
});

test("terminal result follows exact event contracts, HTTP failures and the latest terminal evidence", () => {
  for (const status of [200, 302, 400, 503, "401", null]) {
    const [call] = summarize([event("runtime_server_request_settled", { provider: "first", status })]);
    assert.equal(call.state, status === null ? "unknown" : Number(status) < 400 ? "succeeded" : "failed");
  }
  const [recovered] = summarize([
    event("tool_candidates_exhausted", {}, { level: "error" }),
    event("tool_run_settled", { provider: "second" }, { timestamp: "2026-10-16T10:00:03.000Z" }),
    event("unrelated_settled", {}, { timestamp: "2026-10-16T10:00:04.000Z", level: "error" })
  ]);
  assert.equal(recovered.state, "succeeded");
  assert.equal(recovered.provider, "second");
  const [exhausted] = summarize([event("tool_start", { provider: "first" }), event("tool_candidates_exhausted", { exitCode: 1 })]);
  assert.equal(exhausted.state, "failed");
  assert.equal(exhausted.provider, null);
});

test("session links require an explicit matching persisted ID, never similar timestamps or Provider", () => {
  const sessions = new Set(["ses_known"]);
  const [unlinked] = summarize([event("tool_start", { provider: "first" }), event("tool_run_settled", { provider: "first", sessionId: "external_session" })], sessions);
  assert.deepEqual(unlinked.sessionIds, []);
  const [linked] = summarize([event("tool_start", { sessionId: "ses_known" }), event("tool_run_settled", { sessionId: "ses_known" })], sessions);
  assert.deepEqual(linked.sessionIds, ["ses_known"]);
});
