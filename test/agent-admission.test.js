import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerTelegramEngine } from "../dist/telegram/engine/registry.js";
import { CodexEngine } from "../dist/telegram/engine/codex-engine.js";
import { startRuntimeServer } from "../dist/server/runtime-server.js";

test("Agent admission reserves concurrency before asynchronous setup and disconnect cancels the run", async () => {
  const previous = process.env.AI_GATEWAY_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-admission-"));
  process.env.AI_GATEWAY_HOME = root;
  let runs = 0;
  let cancelled;
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  let started;
  const execution = new Promise(resolve => { started = resolve; });
  registerTelegramEngine("codex", () => ({ execute: async input => {
    runs += 1; started();
    return new Promise(resolve => input.signal.addEventListener("abort", () => { cancelled(); resolve({ response: "cancelled" }); }, { once: true }));
  } }));
  const server = await startRuntimeServer({ port: 0, token: "test", agentMaxConcurrentRuns: 1, agentWorkspaceRoot: path.join(root, "workspaces") });
  const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
  const body = JSON.stringify({ engine: "codex", prompt: "hello", workspace_id: "workspace" });
  const controller = new AbortController();
  const originalMkdir = fs.mkdir;
  let setupEntered;
  const setup = new Promise(resolve => { setupEntered = resolve; });
  let releaseSetup;
  const setupGate = new Promise(resolve => { releaseSetup = resolve; });
  fs.mkdir = async (...args) => {
    if (args[0] === path.join(root, "workspaces", "workspace")) { setupEntered(); await setupGate; }
    return originalMkdir(...args);
  };
  try {
    const first = fetch(`${server.baseUrl}/v1/agent/runs`, { method: "POST", headers, body, signal: controller.signal }).catch(error => error);
    await setup;
    const second = fetch(`${server.baseUrl}/v1/agent/runs`, { method: "POST", headers, body });
    assert.equal((await second).status, 429);
    releaseSetup();
    await execution;
    assert.equal(runs, 1);
    controller.abort(); await first;
    await Promise.race([cancellation, new Promise((_, reject) => setTimeout(() => reject(new Error("Run was not cancelled")), 2000))]);
  } finally {
    releaseSetup(); fs.mkdir = originalMkdir;
    controller.abort(); await server.close();
    registerTelegramEngine("codex", () => new CodexEngine());
    if (previous === undefined) delete process.env.AI_GATEWAY_HOME; else process.env.AI_GATEWAY_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
