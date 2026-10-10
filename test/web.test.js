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
    assert.deepEqual(usage.providers[0].daily.at(-1), { date: latest.date, inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    assert.deepEqual(usage.providers[1].daily, [{ date: latest.date, inputTokens: 20, outputTokens: 10, totalTokens: 30 }]);
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

test("local Web serves the panel, protects mutations, and redacts secrets", async () => {
  const previousHome = process.env.AI_GATEWAY_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-web-test-"));
  process.env.AI_GATEWAY_HOME = root;
  process.env.CODEX_HOME = path.join(root, "codex");
  await writeProviders([{ name: "sample", baseUrl: "https://example.test/v1", apiKey: "super-secret-api-key", mode: "auto", level: 1, model: "gpt-test" }]);
  await writeCache({ providers: { sample: { status: "ok", models: ["gpt-test"], lastCheckedAt: "2026-10-09T00:00:00.000Z", lastError: null } } });
  await appendUsageEvent({ provider: "sample", tool: "codex", model: "gpt-test", source: "proxy", inputTokens: 10, outputTokens: 5, totalTokens: 15, createdAt: "2026-10-09T00:00:00.000Z" });
  await writeLog({ category: "provider", action: "test_event", message: "super-secret-log-message", metadata: { provider: "sample", apiKey: "super-secret-api-key" } });
  const server = await startLocalWebServer();
  const url = new URL(server.url);
  const token = url.hash.slice("#access=".length);
  const baseUrl = url.origin;

  try {
    assert.match(token, /^[a-f0-9]{64}$/);
    const html = await fetch(baseUrl);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /AxiomRuntime/);

    assert.equal((await fetch(`${baseUrl}/api/state`)).status, 401);
    const state = await fetch(`${baseUrl}/api/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(state.status, 200);
    const body = await state.text();
    assert.doesNotMatch(body, /super-secret-api-key|super-secret-log-message/);
    const dashboard = JSON.parse(body);
    assert.equal(dashboard.providers[0].credentialConfigured, true);
    assert.equal(dashboard.usage.totalTokens, 15);
    assert.equal(dashboard.logs[0].action, "test_event");

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
