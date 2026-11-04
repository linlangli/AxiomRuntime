import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyLocalSettings, getLocalSettings } from "../dist/core/web/local-settings.js";
import { loadRuntimeConfig } from "../dist/core/config/runtime-config.js";
import { loadBotConfig } from "../dist/core/config/telegram-config.js";
import { loadServiceExposure, saveServiceExposure, createServiceCredential, revokeServiceCredential } from "../dist/core/config/service-exposure.js";
import { appendUsageEvent } from "../dist/core/config/usage-store.js";
import { startRuntimeServer } from "../dist/server/runtime-server.js";
import { startLocalWebServer } from "../dist/web/local-server.js";

async function isolated(run) {
  const previous = { home: process.env.AI_GATEWAY_HOME, codex: process.env.CODEX_HOME };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-settings-"));
  process.env.AI_GATEWAY_HOME = root;
  process.env.CODEX_HOME = path.join(root, "codex");
  try { await run(root); }
  finally {
    if (previous.home === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codex;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("Web settings persist shared Runtime values, reject invalid inputs, and restore a managed snapshot", () => isolated(async root => {
  await applyLocalSettings({ action: "failover", enabled: false });
  assert.equal((await loadRuntimeConfig()).failoverDisabled, true);
  const backup = await applyLocalSettings({ action: "backup" });
  await applyLocalSettings({ action: "failover", enabled: true });
  assert.equal((await loadRuntimeConfig()).failoverDisabled, undefined);
  await applyLocalSettings({ action: "restore", id: backup.id });
  assert.equal((await loadRuntimeConfig()).failoverDisabled, true);
  await assert.rejects(applyLocalSettings({ action: "failover", enabled: "false" }), /布尔值/);
  await assert.rejects(applyLocalSettings({ action: "restore", id: "../../providers" }), /编号无效/);
  await assert.rejects(applyLocalSettings({ action: "telegram", name: "../../escape", defaultEngine: "claude" }), /Bot 名称/);
  await applyLocalSettings({ action: "telegram", name: "personal", token: "private-bot-token", defaultEngine: "codex", defaultCwd: root, allowedUserIds: [123], provider: "", model: "", proxyUrl: "" });
  const bot = await loadBotConfig("personal");
  assert.equal(bot.defaultPermissionMode, "default");
  assert.deepEqual(bot.allowedUserIds, [123]);
  const settings = await getLocalSettings();
  assert.equal(settings.bots[0].tokenConfigured, true);
  assert.doesNotMatch(JSON.stringify(settings), /private-bot-token/);
  assert.ok(settings.backups.length > 0);
  assert.ok((await fs.stat(path.join(root, "web-backups"))).isDirectory());
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(root, "runtime.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(root, "web-backups", `${backup.id}.json`))).mode & 0o777, 0o600);
  }
}));

test("service authorization enforces both capability scopes and live credential revocation", () => isolated(async root => {
  await assert.rejects(saveServiceExposure({ publicBaseUrl: "https://example.test", upstreamUrl: "http://127.0.0.1:8080", capabilities: ["unknown"] }), /已实现/);
  await assert.rejects(saveServiceExposure({ publicBaseUrl: "http://example.test", upstreamUrl: "http://127.0.0.1:8080", capabilities: ["models"] }), /HTTPS/);
  await assert.rejects(saveServiceExposure({ publicBaseUrl: "https://example.test/path", upstreamUrl: "http://127.0.0.1:8080", capabilities: ["models"] }), /路径/);
  await saveServiceExposure({ publicBaseUrl: "https://example.test", upstreamUrl: "http://127.0.0.1:8080", capabilities: ["models", "chat"] });
  const created = await createServiceCredential("test server", ["models"]);
  assert.match(created.token, /^axm_[a-f0-9]{64}$/);
  assert.doesNotMatch(await fs.readFile(path.join(root, "service-exposure.json"), "utf8"), new RegExp(created.token));
  assert.doesNotMatch(JSON.stringify(await getLocalSettings()), /tokenHash/);
  const server = await startRuntimeServer({ port: 0, useExposureConfig: true, token: "existing-env-token", agentWorkspaceRoot: path.join(root, "workspaces") });
  const headers = { authorization: `Bearer ${created.token}` };
  try {
    assert.equal((await fetch(`${server.baseUrl}/v1/models`, { headers })).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/v1/chat/completions`, { method: "POST", headers })).status, 403);
    await saveServiceExposure({ publicBaseUrl: "https://example.test", upstreamUrl: "http://127.0.0.1:8080", capabilities: [] });
    assert.equal((await fetch(`${server.baseUrl}/v1/models`, { headers })).status, 403);
    assert.equal((await fetch(`${server.baseUrl}/v1/models`, { headers: { authorization: "Bearer existing-env-token" } })).status, 403);
    await revokeServiceCredential(created.id);
    assert.equal((await fetch(`${server.baseUrl}/v1/models`, { headers })).status, 401);
    assert.equal((await fetch(`${server.baseUrl}/health/live`)).status, 200);
  } finally { await server.close(); }
}));

test("restoring a snapshot does not reactivate revoked service credentials", () => isolated(async () => {
  await saveServiceExposure({ publicBaseUrl: "", upstreamUrl: "http://127.0.0.1:8080", capabilities: ["models"] });
  const created = await createServiceCredential("server", ["models"]);
  const backup = await applyLocalSettings({ action: "backup" });
  await revokeServiceCredential(created.id);
  await applyLocalSettings({ action: "restore", id: backup.id });
  assert.equal((await loadServiceExposure()).credentials.length, 0);
}));

test("settings and service mutations keep local Web host, origin and token protections", () => isolated(async () => {
  const server = await startLocalWebServer();
  const address = new URL(server.url);
  const headers = { authorization: `Bearer ${address.hash.slice(8)}`, origin: address.origin, "content-type": "application/json" };
  const send = (endpoint, body, requestHeaders = headers) => fetch(`${address.origin}${endpoint}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  try {
    assert.equal((await send("/api/exposure/service", { action: "start" }, { ...headers, authorization: "Bearer invalid" })).status, 401);
    assert.equal((await send("/api/exposure/tunnel", { action: "start" }, { ...headers, authorization: "Bearer invalid" })).status, 401);
    assert.equal((await send("/api/exposure/tunnel", { action: "start" }, { ...headers, origin: "https://other.example" })).status, 403);
    assert.equal((await send("/api/exposure/tunnel", { action: "unknown" })).status, 400);
    assert.equal((await send("/api/exposure/service", { action: "start" }, { ...headers, origin: "https://other.example" })).status, 403);
    assert.equal((await send("/api/exposure/service", { action: "unknown" })).status, 400);
    assert.equal((await send("/api/settings", { action: "failover", enabled: false })).status, 200);
    assert.equal((await send("/api/settings", { action: "failover", enabled: true }, { ...headers, origin: "https://other.example" })).status, 403);
    assert.equal((await send("/api/exposure", { publicBaseUrl: "", upstreamUrl: "http://127.0.0.1:8080", capabilities: ["models"] })).status, 200);
    const created = await send("/api/exposure/credentials", { name: "server", capabilities: ["models"] });
    assert.equal(created.status, 200);
    const credential = await created.json();
    const state = await fetch(`${address.origin}/api/state`, { headers });
    const payload = await state.text();
    assert.doesNotMatch(payload, new RegExp(credential.token));
    assert.doesNotMatch(payload, /tokenHash/);
    assert.equal((await send("/api/exposure", { publicBaseUrl: "", upstreamUrl: "http://127.0.0.1:8080", capabilities: ["imaginary"] })).status, 400);
    assert.equal((await send("/api/settings", { action: "restore", id: "../outside" })).status, 400);
  } finally { await server.close(); }
}));

test("Web pricing edits persist, feed dashboard cost estimates, and reject invalid values", () => isolated(async () => {
  await appendUsageEvent({ provider: "acme", tool: "codex", model: "model-a", source: "proxy", inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, createdAt: new Date().toISOString() });
  const server = await startLocalWebServer();
  const address = new URL(server.url);
  const headers = { authorization: `Bearer ${address.hash.slice(8)}`, origin: address.origin, "content-type": "application/json" };
  const send = (method, body) => fetch(`${address.origin}/api/pricing`, { method, headers, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(`${address.origin}/api/pricing`, { headers })).json(), {});
    assert.equal((await send("PUT", { providerName: "acme", model: "model-a", inputPerMillionUsd: 2, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 1 })).status, 200);
    const state = await (await fetch(`${address.origin}/api/state`, { headers })).json();
    assert.deepEqual(state.pricing["acme/model-a"], { inputPerMillionUsd: 2, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 1 });
    assert.equal(state.usage.estimatedCostUsd, 0.004);
    assert.equal((await send("PUT", { providerName: "acme", model: "model-a", inputPerMillionUsd: -1, outputPerMillionUsd: 4 })).status, 400);
    assert.equal((await (await fetch(`${address.origin}/api/pricing`, { headers })).json())["acme/model-a"].inputPerMillionUsd, 2);
    assert.equal((await send("DELETE", { providerName: "acme", model: "model-a" })).status, 200);
    assert.deepEqual((await (await fetch(`${address.origin}/api/pricing`, { headers })).json()), {});
  } finally { await server.close(); }
}));
