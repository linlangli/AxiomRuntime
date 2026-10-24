import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeCache } from "../dist/core/config/cache-store.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { appendUsageEvent } from "../dist/core/config/usage-store.js";
import { writeLog } from "../dist/core/logs/log-service.js";
import { startSession, finishSession } from "../dist/core/sessions/session-service.js";
import { startLocalWebServer } from "../dist/web/local-server.js";
import { getWebDashboard } from "../dist/core/web/dashboard-service.js";

test("Web usage separates Provider daily tokens and retains activity beyond 30 recorded days", async () => {
  const previousHome = process.env.AI_GATEWAY_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-web-usage-test-"));
  process.env.AI_GATEWAY_HOME = root;
  process.env.CODEX_HOME = path.join(root, "codex");
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const events = Array.from({ length: 60 }, (_, index) => ({
      provider: "first", tool: "codex", model: "gpt-test", source: "proxy",
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
      createdAt: new Date(today.getTime() - index * 86400000).toISOString()
    }));
    for (const event of events) await appendUsageEvent(event);
    await appendUsageEvent({ ...events[0], inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    await appendUsageEvent({ ...events[0], provider: "second", inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    const { usage } = await getWebDashboard();
    assert.equal(usage.totalTokens, 935);
    assert.equal(usage.daily.length, 60);
    assert.equal(usage.daily[0].date, events[59].createdAt.slice(0, 10));
    assert.equal(usage.daily[0].totalTokens, 15);
    const latest = usage.daily.at(-1);
    assert.equal(latest.inputTokens, 32);
    assert.equal(latest.outputTokens, 18);
    assert.equal(latest.totalTokens, 50);
    assert.deepEqual(usage.providers.map(provider => [provider.provider, provider.totalTokens]), [["first", 905], ["second", 30]]);
    assert.equal(usage.providers[0].daily.length, 60);
    assert.deepEqual(usage.providers[0].daily.at(-1), { date: latest.date, inputTokens: 12, outputTokens: 8, totalTokens: 20, estimatedCostUsd: 0, unpricedEvents: 2 });
    assert.deepEqual(usage.providers[1].daily, [{ date: latest.date, inputTokens: 20, outputTokens: 10, totalTokens: 30, estimatedCostUsd: 0, unpricedEvents: 1 }]);
    for (const day of usage.daily) {
      const totals = usage.providers.flatMap(provider => provider.daily.filter(providerDay => providerDay.date === day.date));
      for (const metric of ["inputTokens", "outputTokens", "totalTokens"]) {
        assert.equal(totals.reduce((sum, providerDay) => sum + providerDay[metric], 0), day[metric]);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("Web usage exposes every historical model for each Provider", async () => {
  const previousHome = process.env.AI_GATEWAY_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-web-models-test-"));
  process.env.AI_GATEWAY_HOME = root;
  process.env.CODEX_HOME = path.join(root, "codex");
  try {
    await appendUsageEvent({ provider: "first", tool: "codex", model: "gpt-new", source: "proxy", inputTokens: 10, outputTokens: 5, totalTokens: 15, createdAt: "2026-10-15T10:00:00.000Z" });
    await appendUsageEvent({ provider: "first", tool: "codex", model: "gpt-old", source: "proxy", inputTokens: 2, outputTokens: 3, totalTokens: 5, createdAt: "2026-10-14T10:00:00.000Z" });
    await appendUsageEvent({ provider: "first", tool: "codex", model: "gpt-new", source: "proxy", inputTokens: 4, outputTokens: 1, totalTokens: 5, createdAt: "2026-10-16T10:00:00.000Z" });
    const { usage } = await getWebDashboard();
    assert.deepEqual(usage.providers[0].models, [
      { model: "gpt-new", totalTokens: 20, lastUsedAt: "2026-10-16T10:00:00.000Z" },
      { model: "gpt-old", totalTokens: 5, lastUsedAt: "2026-10-14T10:00:00.000Z" }
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("local Web rejects missing or unreadable console assets before listening", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-web-assets-test-"));
  const startAndClose = async (assetRoot) => {
    const server = await startLocalWebServer({ assetRoot });
    await server.close();
  };
  try {
    await assert.rejects(startAndClose(path.join(root, "missing")), /Local Web assets.*npm ci --prefix web.*npm run build.*reinstall/);
    await assert.rejects(startAndClose(root), /Local Web assets/);
    await fs.mkdir(path.join(root, "console.html"));
    await assert.rejects(startAndClose(root), /Local Web assets/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("local Web serves the panel, protects mutations, and redacts secrets", async () => {
  const previousHome = process.env.AI_GATEWAY_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-web-test-"));
  process.env.AI_GATEWAY_HOME = root;
  process.env.CODEX_HOME = path.join(root, "codex");
  await writeProviders([{ name: "sample", baseUrl: "https://example.test/v1", apiKey: "super-secret-api-key", mode: "auto", level: 1, model: "gpt-test" }]);
  await writeCache({ providers: { sample: { status: "ok", models: ["gpt-test"], lastCheckedAt: "2026-10-09T00:00:00.000Z", lastError: null } } });
  await appendUsageEvent({ provider: "sample", tool: "codex", model: "gpt-test", source: "proxy", inputTokens: 10, outputTokens: 5, totalTokens: 15, createdAt: "2026-10-09T00:00:00.000Z" });
  const session = await startSession({ tool: "codex", provider: "sample", model: "gpt-test", mode: "auto", projectPath: root, fallbackFrom: null });
  await finishSession(session.id, 1);
  await writeLog({ category: "usage", action: "runtime_server_request_settled", message: "super-secret-log-message", traceId: "request-test", metadata: { provider: "sample", model: "gpt-test", status: 503, sessionId: session.id, apiKey: "super-secret-api-key" } });
  await writeLog({ category: "provider", action: "test_event", message: "super-secret-log-message", metadata: { provider: "sample", apiKey: "super-secret-api-key" } });
  const server = await startLocalWebServer();
  const url = new URL(server.url);
  const token = url.hash.slice("#access=".length);
  const baseUrl = url.origin;

  try {
    assert.match(token, /^[a-f0-9]{64}$/);
    const html = await fetch(baseUrl);
    assert.equal(html.status, 200);
    const document = await html.text();
    assert.match(document, /AxiomRuntime/);
    const assets = [...document.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
    assert.ok(assets.length > 0);
    for (const [, asset] of assets) {
      const response = await fetch(new URL(asset, baseUrl));
      assert.equal(response.status, 200, asset);
      assert.ok((await response.arrayBuffer()).byteLength > 0, asset);
    }

    assert.equal((await fetch(`${baseUrl}/api/state`)).status, 401);
    const state = await fetch(`${baseUrl}/api/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(state.status, 200);
    const body = await state.text();
    assert.doesNotMatch(body, /super-secret-api-key|super-secret-log-message/);
    const dashboard = JSON.parse(body);
    assert.equal(dashboard.providers[0].credentialConfigured, true);
    assert.equal(dashboard.usage.totalTokens, 15);
    assert.equal(dashboard.logs[0].action, "test_event");
    assert.equal(dashboard.calls.length, 1);
    assert.equal(dashboard.calls[0].state, "failed");
    assert.equal(dashboard.calls[0].provider, "sample");
    assert.equal(dashboard.calls[0].events[0].status, 503);
    assert.deepEqual(dashboard.calls[0].sessionIds, [session.id]);
    assert.equal(dashboard.sessions[0].exitCode, 1);

    const mutation = { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ name: "sample" }) };
    assert.equal((await fetch(`${baseUrl}/api/providers/refresh`, mutation)).status, 403);
    const invalidHostStatus = await new Promise((resolve, reject) => {
      http.get(`${baseUrl}/api/state`, { headers: { authorization: `Bearer ${token}`, host: "evil.example" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }).on("error", reject);
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(`${baseUrl}/private.json`)).status, 404);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});
