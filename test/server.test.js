import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeCache } from "../dist/core/config/cache-store.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { startRuntimeServer } from "../dist/server/runtime-server.js";
import { readUsage } from "../dist/core/config/usage-store.js";

test("runtime server authenticates, lists models, and falls back between providers", async () => {
  const originalHome = process.env.AI_GATEWAY_HOME;
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-router-server-"));
  const first = await startUpstream(503, { error: { message: "temporary" } });
  const second = await startUpstream(200, {
    id: "chatcmpl-ok",
    object: "chat.completion",
    model: "gpt-test",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
  });
  process.env.AI_GATEWAY_HOME = configRoot;

  await writeProviders([
    { name: "first", baseUrl: first.baseUrl, apiKey: "key-1", mode: "auto", level: 1, model: "gpt-test" },
    { name: "second", baseUrl: second.baseUrl, apiKey: "key-2", mode: "auto", level: 2, model: "gpt-test" }
  ]);
  await writeCache({
    providers: {
      first: { status: "ok", models: ["gpt-test"], lastCheckedAt: null, lastError: null },
      second: { status: "ok", models: ["gpt-test"], lastCheckedAt: null, lastError: null }
    }
  });
  const server = await startRuntimeServer({ token: "internal-secret", port: 0, agentWorkspaceRoot: path.join(configRoot, "workspaces") });

  try {
    const health = await fetch(`${server.baseUrl}/health/ready`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(`${server.baseUrl}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const models = await fetch(`${server.baseUrl}/v1/models`, {
      headers: { authorization: "Bearer internal-secret" }
    });
    assert.deepEqual((await models.json()).data.map((model) => model.id), ["gpt-test"]);

    const completion = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer internal-secret",
        "content-type": "application/json",
        "x-request-id": "req-test"
      },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(completion.status, 200);
    assert.equal(completion.headers.get("x-agent-router-provider"), "second");
    assert.equal((await completion.json()).choices[0].message.content, "ok");
    assert.equal(first.requests, 1);
    assert.equal(second.requests, 1);
    const repeated = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer internal-secret", "content-type": "application/json", "x-request-id": "req-test" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "another request" }] })
    });
    assert.equal(repeated.status, 200); await repeated.text();
    const events = (await readUsage()).events;
    assert.equal(events.length, 2);
    assert.equal(new Set(events.map(event => event.id)).size, 2);
    assert.ok(events.every(event => event.traceId === "req-test"));

    const unsafeWorkspace = await fetch(`${server.baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: "Bearer internal-secret", "content-type": "application/json" },
      body: JSON.stringify({ engine: "codex", prompt: "hello", workspace_id: "../escape" })
    });
    assert.equal(unsafeWorkspace.status, 400);
  } finally {
    await Promise.all([server.close(), first.close(), second.close()]);
    await fs.rm(configRoot, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = originalHome;
  }
});

test("runtime server enforces the configured request size limit", async () => {
  const originalHome = process.env.AI_GATEWAY_HOME;
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-router-limit-"));
  process.env.AI_GATEWAY_HOME = configRoot;
  await writeProviders([{ name: "only", baseUrl: "https://example.test", apiKey: "key", mode: "auto", level: 1, model: "gpt-test" }]);
  const server = await startRuntimeServer({ token: "secret", port: 0, maxRequestBytes: 32, agentWorkspaceRoot: path.join(configRoot, "workspaces") });
  try {
    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "x".repeat(100) }] })
    });
    assert.equal(response.status, 413);
  } finally {
    await server.close();
    await fs.rm(configRoot, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.AI_GATEWAY_HOME;
    else process.env.AI_GATEWAY_HOME = originalHome;
  }
});

async function startUpstream(status, payload) {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    requests += 1;
    for await (const _ of req) {
      // Drain request body before responding.
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() { return requests; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
