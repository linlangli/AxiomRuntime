import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addProvider, deleteProvider, updateProvider } from "../dist/core/providers/provider-service.js";
import { readCache, recordProviderRuntimeFailure, upsertProviderCache } from "../dist/core/config/cache-store.js";
import { readProviders, writeProviders } from "../dist/core/config/providers-store.js";
import { getProviderStatuses } from "../dist/core/status/status-service.js";
import { runDeepDoctor, runDoctor } from "../dist/core/status/doctor-service.js";
import { resolveExactProviderForTool, resolveProviderForTool, resolveProviderCandidatesForTool } from "../dist/core/runner/fallback.js";
import { checkAndRecordMemoryEmbeddingConfig } from "../dist/core/memory/embedding-check.js";
import {
  clearMemoryEmbeddingConfig,
  getMemoryEmbeddingConfig,
  setMemoryEmbeddingConfig
} from "../dist/core/memory/memory-config.js";
import { clearAllSessions, finishSession, getSession, listRecentSessions, startSession } from "../dist/core/sessions/session-service.js";
import { generateSessionReport } from "../dist/core/reports/report-service.js";
import {
  getIntegrationProviderState,
  hasPendingProviderChanges,
  markIntegrationProvidersSynced,
  readIntegrationState,
  registerIntegration
} from "../dist/core/integrations/integration-state.js";

const ORIGINAL_FETCH = globalThis.fetch;

test("addProvider writes provider config and model cache", async () => {
  await withTempHome(async () => {
    mockFetchModels(["gpt-5.5", "claude-opus-4-6"]);

    const provider = await addProvider({
      name: "test",
      baseUrl: "https://api.test/v1/",
      apiKey: "sk-test"
    });

    assert.equal(provider.name, "test");
    assert.equal(provider.level, 1);
    assert.equal(provider.mode, "auto");
    assert.equal(provider.baseUrl, "https://api.test/v1");
    assert.equal(provider.model, "claude-opus-4-6");

    const providers = await readProviders();
    const cache = await readCache();
    assert.equal(providers.length, 1);
    assert.equal(cache.providers.test.status, "ok");
    assert.deepEqual(cache.providers.test.models, ["claude-opus-4-6", "gpt-5.5"]);
  });
});

test("updateProvider edits mode, swaps level, and renames cache", async () => {
  await withTempHome(async () => {
    mockFetchModels(["claude-opus-4-6"]);
    await writeProviders([
      { name: "a", baseUrl: "https://a.test/v1", apiKey: "a", mode: "auto", level: 1, model: "claude-opus-4-6" },
      { name: "b", baseUrl: "https://b.test/v1", apiKey: "b", mode: "auto", level: 2, model: "claude-opus-4-6" }
    ]);
    await upsertProviderCache("b", { status: "ok", models: ["claude-opus-4-6"], lastCheckedAt: "now", lastError: null });

    await updateProvider("b", { name: "renamed", mode: "ask", level: 1 });
    const providers = await readProviders();
    const cache = await readCache();

    assert.equal(providers.find((provider) => provider.name === "renamed").mode, "ask");
    assert.equal(providers.find((provider) => provider.name === "renamed").level, 1);
    assert.equal(providers.find((provider) => provider.name === "a").level, 2);
    assert.equal(cache.providers.renamed.status, "ok");
    assert.equal(cache.providers.b, undefined);
  });
});

test("deleteProvider removes provider config and cache", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "a", baseUrl: "https://a.test/v1", apiKey: "a", mode: "auto", level: 1, model: "claude-opus-4-6" },
      { name: "b", baseUrl: "https://b.test/v1", apiKey: "b", mode: "auto", level: 2, model: "gpt-5.5" }
    ]);
    await upsertProviderCache("a", { status: "ok", models: ["claude-opus-4-6"], lastCheckedAt: "now", lastError: null });
    await upsertProviderCache("b", { status: "ok", models: ["gpt-5.5"], lastCheckedAt: "now", lastError: null });

    const deleted = await deleteProvider("a");
    const providers = await readProviders();
    const cache = await readCache();

    assert.equal(deleted.name, "a");
    assert.equal(providers.length, 1);
    assert.equal(providers[0].name, "b");
    assert.equal(providers[0].level, 1);
    assert.equal(cache.providers.a, undefined);
    assert.equal(cache.providers.b.status, "ok");
  });
});

test("memory embedding config stores dedicated vector model settings", async () => {
  await withTempHome(async () => {
    const config = await setMemoryEmbeddingConfig({
      name: "jina",
      baseUrl: "https://api.jina.ai/v1/",
      apiKey: "jina-key",
      model: "jina-embeddings-v3"
    });

    assert.equal(config.name, "jina");
    assert.equal(config.baseUrl, "https://api.jina.ai/v1");
    assert.equal(config.providerType, "jina");
    assert.equal(config.queryTask, "retrieval.query");
    assert.equal(config.passageTask, "retrieval.passage");

    const saved = await getMemoryEmbeddingConfig();
    assert.equal(saved.model, "jina-embeddings-v3");
    assert.equal(saved.apiKey, "jina-key");

    assert.equal(await clearMemoryEmbeddingConfig(), true);
    assert.equal(await getMemoryEmbeddingConfig(), null);
  });
});

test("memory embedding check records vector dimensions", async () => {
  await withTempHome(async () => {
    mockFetch((url, init) => {
      assert.equal(String(url), "https://api.jina.ai/v1/embeddings");
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, "jina-embeddings-v3");
      assert.equal(body.task, "retrieval.query");
      return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    });
    const config = await setMemoryEmbeddingConfig({
      name: "jina",
      baseUrl: "https://api.jina.ai/v1",
      apiKey: "jina-key",
      model: "jina-embeddings-v3"
    });

    const result = await checkAndRecordMemoryEmbeddingConfig(config);
    const saved = await getMemoryEmbeddingConfig();

    assert.equal(result.status, "ok");
    assert.equal(result.dimensions, 3);
    assert.equal(saved.dimensions, 3);
    assert.equal(saved.lastError, null);
    assert.equal(typeof saved.lastCheckedAt, "string");
  });
});

test("getProviderStatuses refreshes health and aggregates weekly tokens", async () => {
  await withTempHome(async () => {
    mockFetchModels(["gpt-5.5"]);
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.5" }
    ]);
    await fs.writeFile(
      path.join(process.env.AI_GATEWAY_HOME, "usage.json"),
      JSON.stringify({
        events: [
          {
            provider: "api",
            tool: "codex",
            model: "gpt-5.5",
            source: "doctor_deep",
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            createdAt: new Date().toISOString()
          }
        ]
      })
    );

    const statuses = await getProviderStatuses({ refresh: true });
    assert.equal(statuses[0].health, "ok");
    assert.equal(statuses[0].models.length, 1);
    assert.equal(statuses[0].weeklyTokens, 15);
    assert.equal(statuses[0].usageShare, 100);
    assert.equal(statuses[0].codex.state, "ready");
    assert.equal(statuses[0].codex.baseUrl, "https://api.test/v1");
    assert.equal(statuses[0].claude.state, "no-model");
    assert.equal(statuses[0].claude.baseUrl, "https://api.test");
  });
});

test("getProviderStatuses reports tool-specific runtime readiness", async () => {
  await withTempHome(async () => {
    mockFetchModels(["claude-sonnet-4-6", "gpt-5.5"]);
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "claude-sonnet-4-6" }
    ]);

    const statuses = await getProviderStatuses({ refresh: true });

    assert.equal(statuses[0].claude.state, "ready");
    assert.equal(statuses[0].claude.model, "claude-sonnet-4-6");
    assert.equal(statuses[0].claude.baseUrl, "https://api.test");
    assert.equal(statuses[0].codex.state, "ready");
    assert.equal(statuses[0].codex.model, "gpt-5.5");
    assert.equal(statuses[0].codex.baseUrl, "https://api.test/v1");
  });
});

test("runDoctor validates config and local CLI checks without throwing", async () => {
  await withTempHome(async () => {
    mockFetchModels(["gpt-5.5"]);
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.5" }
    ]);

    const items = await runDoctor();
    assert.equal(items.some((item) => item.group === "Config" && item.status === "ok"), true);
    assert.equal(items.some((item) => item.group === "Providers" && item.message.includes("api: ok")), true);
    assert.equal(items.some((item) => item.group === "Local CLIs"), true);
  });
});

test("runDeepDoctor records returned usage", async () => {
  await withTempHome(async () => {
    mockFetch((url, init) => {
      if (String(url).endsWith("/models")) {
        return jsonResponse({ data: [{ id: "gpt-5.5" }] });
      }
      if (String(url).endsWith("/chat/completions") && init?.method === "POST") {
        return jsonResponse({
          id: "test",
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6
          }
        });
      }
      return jsonResponse({}, { status: 404 });
    });
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.5" }
    ]);
    await upsertProviderCache("api", { status: "ok", models: ["gpt-5.5"], lastCheckedAt: "now", lastError: null });

    const items = await runDeepDoctor("codex");
    const usage = JSON.parse(await fs.readFile(path.join(process.env.AI_GATEWAY_HOME, "usage.json"), "utf8"));

    assert.equal(items.some((item) => item.group === "Deep" && item.status === "ok"), true);
    assert.equal(usage.events[0].totalTokens, 6);
    assert.equal(usage.events[0].source, "doctor_deep");
  });
});

test("resolveProviderForTool skips unhealthy providers and falls back", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "bad", baseUrl: "https://bad.test/v1", apiKey: "bad", mode: "auto", level: 1, model: "gpt-5.5" },
      { name: "good", baseUrl: "https://good.test/v1", apiKey: "good", mode: "auto", level: 2, model: "gpt-5.4" }
    ]);
    await upsertProviderCache("bad", { status: "error", models: ["gpt-5.5"], lastCheckedAt: "now", lastError: "down" });
    await upsertProviderCache("good", { status: "ok", models: ["gpt-5.4"], lastCheckedAt: "now", lastError: null });

    const resolved = await resolveProviderForTool("codex");
    assert.equal(resolved.provider.name, "good");
    assert.equal(resolved.model, "gpt-5.4");
  });
});

test("explicit model requests drop providers whose catalog lacks that model", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "codex", baseUrl: "https://codex.test/v1", apiKey: "codex", mode: "auto", level: 1, model: "gpt-5.5" },
      { name: "claude-only", baseUrl: "https://claude.test/v1", apiKey: "claude", mode: "auto", level: 2, model: "claude-opus-4-6" }
    ]);
    await upsertProviderCache("codex", { status: "ok", models: ["gpt-5.5", "gpt-5.6-sol"], lastCheckedAt: "now", lastError: null });
    await upsertProviderCache("claude-only", { status: "ok", models: ["claude-opus-4-6"], lastCheckedAt: "now", lastError: null });

    const candidates = await resolveProviderCandidatesForTool("codex", undefined, "gpt-5.6-sol");
    assert.deepEqual(candidates.map((candidate) => candidate.provider.name), ["codex"]);
    assert.equal(candidates.every((candidate) => candidate.model === "gpt-5.6-sol"), true);
  });
});

test("expired runtime circuits become half-open candidates", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "recovering", baseUrl: "https://recovering.test/v1", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.6-sol" }
    ]);
    await upsertProviderCache("recovering", {
      status: "error",
      models: ["gpt-5.6-sol"],
      lastCheckedAt: "now",
      lastError: "temporary upstream failure",
      consecutiveFailures: 3,
      circuitOpenUntil: new Date(Date.now() - 1_000).toISOString()
    });

    const candidates = await resolveProviderCandidatesForTool("codex", "recovering", "gpt-5.6-sol");
    assert.deepEqual(candidates.map((candidate) => candidate.provider.name), ["recovering"]);
  });
});

test("exact provider resolution ignores health routing after candidate selection", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "selected", baseUrl: "https://selected.test/v1", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.6-sol" },
      { name: "other", baseUrl: "https://other.test/v1", apiKey: "key", mode: "auto", level: 2, model: "gpt-5.6-sol" }
    ]);
    await upsertProviderCache("selected", {
      status: "error",
      models: ["gpt-5.6-sol"],
      lastCheckedAt: "now",
      lastError: "temporary upstream failure",
      consecutiveFailures: 3,
      circuitOpenUntil: new Date(Date.now() + 60_000).toISOString()
    });
    await upsertProviderCache("other", { status: "ok", models: ["gpt-5.6-sol"], lastCheckedAt: "now", lastError: null });

    const resolved = await resolveExactProviderForTool("codex", "selected", "gpt-5.6-sol");
    assert.equal(resolved.provider.name, "selected");
    assert.equal(resolved.model, "gpt-5.6-sol");
  });
});

test("runtime provider failures open a circuit breaker after repeated errors", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "flaky", baseUrl: "https://flaky.test/v1", apiKey: "bad", mode: "auto", level: 1, model: "gpt-5.5" },
      { name: "good", baseUrl: "https://good.test/v1", apiKey: "good", mode: "auto", level: 2, model: "gpt-5.4" }
    ]);
    await upsertProviderCache("flaky", { status: "ok", models: ["gpt-5.5"], lastCheckedAt: "now", lastError: null });
    await upsertProviderCache("good", { status: "ok", models: ["gpt-5.4"], lastCheckedAt: "now", lastError: null });

    await recordProviderRuntimeFailure("flaky", "stream disconnected");
    await recordProviderRuntimeFailure("flaky", "stream disconnected");
    await recordProviderRuntimeFailure("flaky", "stream disconnected");

    const cache = await readCache();
    const resolved = await resolveProviderForTool("codex");

    assert.equal(cache.providers.flaky.consecutiveFailures, 3);
    assert.equal(typeof cache.providers.flaky.circuitOpenUntil, "string");
    assert.equal(cache.providers.flaky.healthScore < 100, true);
    assert.equal(resolved.provider.name, "good");
  });
});

test("integration registry tracks provider revisions independently", async () => {
  await withTempHome(async () => {
    registerIntegration({ name: "example" });

    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.5" }
    ]);
    await deleteProvider("api");

    const state = await readIntegrationState();
    const custom = getIntegrationProviderState(state, "example");

    assert.equal(await hasPendingProviderChanges("example"), true);
    assert.equal(custom.pendingProviderChanges.length, 1);
    assert.deepEqual(Object.keys(state.integrations), ["example"]);

    await markIntegrationProvidersSynced("example");
    const synced = await readIntegrationState();

    assert.equal(await hasPendingProviderChanges("example"), false);
    assert.equal(getIntegrationProviderState(synced, "example").pendingProviderChanges.length, 0);
  });
});

test("session service starts, lists, and finishes sessions", async () => {
  await withTempHome(async () => {
    const provider = { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.5" };
    const session = await startSession({
      tool: "codex",
      provider,
      model: "gpt-5.5",
      projectPath: "/tmp/project",
      fallbackFrom: null
    });

    let sessions = await listRecentSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, "running");
    assert.equal(sessions[0].provider, "api");

    await finishSession(session.id, 0);
    const updated = await getSession(session.id);
    sessions = await listRecentSessions();
    assert.equal(updated.status, "completed");
    assert.equal(updated.exitCode, 0);
    assert.equal(sessions[0].id, session.id);
  });
});

test("clearAllSessions removes stored sessions", async () => {
  await withTempHome(async () => {
    const provider = { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.5" };
    await startSession({
      tool: "codex",
      provider,
      model: "gpt-5.5",
      projectPath: "/tmp/project",
      fallbackFrom: null
    });
    await startSession({
      tool: "claude",
      provider: { ...provider, model: "claude-sonnet-4-6" },
      model: "claude-sonnet-4-6",
      projectPath: "/tmp/project",
      fallbackFrom: null
    });

    const count = await clearAllSessions();
    const sessions = await listRecentSessions();

    assert.equal(count, 2);
    assert.equal(sessions.length, 0);
  });
});

test("generateSessionReport writes agent handoff report with session usage", async () => {
  await withTempHome(async (tempDir) => {
    const projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "README.md"), "# Demo Project\n", "utf8");
    const provider = { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "gpt-5.5" };
    await writeProviders([provider]);
    await upsertProviderCache("api", { status: "ok", models: ["gpt-5.5"], lastCheckedAt: "now", lastError: null });
    const session = await startSession({
      tool: "codex",
      provider,
      model: "gpt-5.5",
      projectPath: projectDir,
      fallbackFrom: null
    });
    await fs.writeFile(
      path.join(process.env.AI_GATEWAY_HOME, "usage.json"),
      JSON.stringify({
        events: [
          {
            provider: "api",
            tool: "codex",
            model: "gpt-5.5",
            source: "doctor_deep",
            inputTokens: 20,
            outputTokens: 8,
            totalTokens: 28,
            createdAt: new Date().toISOString()
          }
        ]
      })
    );
    await finishSession(session.id, 0);

    const report = await generateSessionReport(session.id);

    assert.equal(report.filePath.endsWith(`${session.id}.md`), true);
    assert.match(report.content, /# AI Gateway Session Report/);
    assert.match(report.content, /- Total tokens: 28/);
    assert.match(report.content, /## Session Context/);
    assert.match(await fs.readFile(report.filePath, "utf8"), /Demo Project/);
  });
});

async function withTempHome(fn) {
  const previousHome = process.env.AI_GATEWAY_HOME;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-test-"));
  process.env.AI_GATEWAY_HOME = tempDir;
  try {
    await fn(tempDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.AI_GATEWAY_HOME;
    } else {
      process.env.AI_GATEWAY_HOME = previousHome;
    }
    globalThis.fetch = ORIGINAL_FETCH;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function mockFetchModels(models) {
  mockFetch((url, init) => {
    if (String(url).endsWith("/models")) {
      return jsonResponse({ data: models.map((id) => ({ id })) });
    }
    if (init?.method === "POST" && (String(url).endsWith("/chat/completions") || String(url).endsWith("/v1/messages"))) {
      return jsonResponse({
        id: "probe",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2
        }
      });
    }
    return jsonResponse({}, { status: 404 });
  });
}

function mockFetch(handler) {
  globalThis.fetch = async (url, init) => handler(url, init);
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" }
  });
}
