import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { startSession, getSession, finishSession } from "../dist/core/sessions/session-service.js";
import { findNativeCodexSession } from "../dist/core/sessions/native-session.js";
import { startOpenAiUsageProxy } from "../dist/core/runner/openai-usage-proxy.js";
import { recordSessionProvider } from "../dist/core/sessions/session-service.js";
import { appendUsageEvents, readUsage } from "../dist/core/config/usage-store.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { generateSessionReport } from "../dist/core/reports/report-service.js";
import { projectHistoryLogs, summarizeCalls } from "../dist/core/web/execution-history.js";
import { readRecentLogs } from "../dist/core/logs/log-service.js";
import { getWebDashboard } from "../dist/core/web/dashboard-service.js";
import { runTool } from "../dist/core/runner/tool-runner.js";
import { readSessions } from "../dist/core/config/session-store.js";

const provider = { name: "initial", baseUrl: "http://127.0.0.1:1", apiKey: "private", level: 1, mode: "ask", model: "gpt-test" };

async function isolated(run) {
  const previous = { home: process.env.AI_GATEWAY_HOME, codex: process.env.CODEX_HOME };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-attribution-"));
  process.env.AI_GATEWAY_HOME = root; process.env.CODEX_HOME = path.join(root, "codex");
  try { await run(root); } finally {
    if (previous.home === undefined) delete process.env.AI_GATEWAY_HOME; else process.env.AI_GATEWAY_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.codex;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("concurrent proxy requests keep request/session correlation and record the actual fallback route", () => isolated(async root => {
  const upstream = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.input === "slow") await new Promise(resolve => setTimeout(resolve, 20));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ model: request.model, usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, cost_usd: 0.25 }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const fallback = { ...provider, name: "actual", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, level: 2 };
  await writeProviders([provider, fallback]);
  const sessions = await Promise.all(["execution-one", "execution-two"].map(traceId => startSession({ tool: "codex", provider, model: provider.model, projectPath: root, traceId })));
  const proxies = await Promise.all(sessions.map(session => startOpenAiUsageProxy({ provider, model: provider.model, tool: "codex", engine: "codex", traceId: session.traceId, sessionId: session.id, fallbackRoutes: [{ provider: fallback, model: "gpt-actual" }], maxAttemptsPerRoute: 1,
    onRequestSettled: request => request.success ? recordSessionProvider(session.id, request) : undefined })));
  try {
    await Promise.all(proxies.map(async (proxy, index) => {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: index ? "fast" : "slow", model: provider.model }) });
      assert.equal(response.status, 200); await response.text();
    }));
  } finally {
    await Promise.all(proxies.map(proxy => proxy.close()));
    await new Promise(resolve => upstream.close(resolve));
  }
  const usage = (await readUsage()).events;
  assert.equal(usage.length, 2);
  assert.equal(new Set(usage.map(event => event.traceId)).size, 2);
  assert.deepEqual(new Set(usage.map(event => event.sessionId)), new Set(sessions.map(session => session.id)));
  for (const session of sessions) {
    const saved = await getSession(session.id);
    assert.equal(saved.actualProvider, "actual"); assert.equal(saved.actualModel, "gpt-actual");
    assert.equal(saved.lastRequestId, usage.find(event => event.sessionId === session.id).traceId);
    await finishSession(session.id, 0);
    const report = await generateSessionReport(session.id);
    assert.match(report.content, /Total tokens: 10/);
    assert.match(report.content, /Attribution: exact sessionId/);
  }
  const calls = summarizeCalls(projectHistoryLogs(await readRecentLogs(100)), new Set(sessions.map(session => session.id)));
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(call.state, "succeeded"); assert.equal(call.provider, "actual"); assert.equal(call.totalTokens, 10); assert.ok(call.executionId.startsWith("execution-")); }
}));

test("new-session reports never absorb legacy or concurrent usage and preserve Provider-reported costs", () => isolated(async root => {
  await writeProviders([provider]);
  const session = await startSession({ tool: "codex", provider, model: provider.model, projectPath: root, traceId: "execution" });
  const base = { createdAt: new Date().toISOString(), provider: provider.name, model: provider.model, tool: "codex", inputTokens: 1, outputTokens: 2, totalTokens: 3, source: "proxy" };
  await appendUsageEvents([{ ...base, id: "owned", sessionId: session.id, costUsd: 0.25, costSource: "provider" }, { ...base, id: "concurrent", sessionId: "other" }, { ...base, id: "legacy" }]);
  await finishSession(session.id, 0);
  assert.match((await generateSessionReport(session.id)).content, /Usage events matched to this session: 1/);
  const dashboard = await getWebDashboard();
  assert.ok(dashboard.usage.estimatedCostUsd >= 0.25);
}));

test("native Codex detection requires unique CLI metadata, matching directory and execution interval", () => isolated(async root => {
  const now = Date.now(); const date = new Date(now);
  const directory = path.join(process.env.CODEX_HOME, "sessions", String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0"));
  await fs.mkdir(directory, { recursive: true });
  const write = async (name, overrides = {}) => {
    const id = randomUUID();
    await fs.writeFile(path.join(directory, `${name}.jsonl`), JSON.stringify({ type: "session_meta", timestamp: new Date(now).toISOString(), payload: { id, cwd: root, source: "cli", ...overrides } }) + '\n{"prompt":"private-content"}\n');
    return id;
  };
  await write("desktop", { source: "vscode" }); await write("other-project", { cwd: path.join(root, "other") });
  const input = { cwd: root, startedAt: now - 100, finishedAt: now + 100 };
  assert.equal(await findNativeCodexSession(input), undefined);
  const id = await write("valid");
  assert.equal(await findNativeCodexSession(input), id);
  await write("ambiguous");
  assert.equal(await findNativeCodexSession(input), undefined);
  assert.equal(await findNativeCodexSession({ ...input, startedAt: now + 10_000, finishedAt: now + 20_000 }), undefined);
}));

test("CLI native resume keeps the project and conversation ID, signal exits are failures and listeners are cleaned up", () => isolated(async root => {
  const directory = path.join(root, "bin"); const project = path.join(root, "project");
  await fs.mkdir(directory); await fs.mkdir(project);
  const capture = path.join(root, "launch.jsonl");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) process.exit(0);
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
if (process.argv.includes("resume")) process.kill(process.pid, "SIGTERM");
`;
  await fs.writeFile(path.join(directory, "claude"), script, { mode: 0o755 });
  await fs.writeFile(path.join(directory, "codex"), script, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  try {
    assert.equal(await runTool("claude", provider, "claude-test", { cwd: project }), 0);
    const first = (await readSessions()).sessions[0];
    assert.ok(first.nativeSessionId);
    assert.equal(await runTool("claude", provider, "claude-test", { cwd: project, nativeSessionId: first.nativeSessionId, resumedFrom: first.id }), 0);
    const native = randomUUID();
    assert.equal(await runTool("codex", provider, "gpt-test", { cwd: project, nativeSessionId: native }), 143);
    const launches = (await fs.readFile(capture, "utf8")).trim().split("\n").map(JSON.parse);
    const realProject = await fs.realpath(project);
    assert.ok(launches.every(launch => launch.cwd === realProject));
    assert.equal(launches[0].args[launches[0].args.indexOf("--session-id") + 1], first.nativeSessionId);
    assert.equal(launches[1].args[launches[1].args.indexOf("--resume") + 1], first.nativeSessionId);
    assert.deepEqual(launches[2].args.slice(0, 2), ["resume", native]);
    assert.equal((await readSessions()).sessions.at(-1).status, "failed");
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
}));
