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
import {
  addHermesRobot,
  clearHermesRobot,
  deleteHermesRobot,
  ensureHermesProviderSync,
  exportHermesRobot,
  getHermesRobotStatuses,
  importHermesRobot,
  importLocalHermesRobots,
  listHermesConfiguredProviders,
  listHermesRobots,
  repairLocalHermesIntegration,
  switchHermesRobotsProvider,
  syncHermesRobotToLocalConfigAndRestart,
  syncHermesRobotToLocalConfig,
  syncHermesProvidersToLocalConfig,
  updateHermesRobot
} from "../dist/core/hermes/hermes-service.js";
import { parseLocalHermesProviderRecords } from "../dist/core/hermes/hermes-local-files.js";
import { getHermesRobotHome, readHermesState, upsertHermesRobotState, writeHermesRobots } from "../dist/core/hermes/hermes-store.js";
import { prepareHermesRuntime } from "../dist/core/hermes/hermes-runner.js";

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

test("integration registry tracks provider revisions independently from Hermes compatibility state", async () => {
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
    assert.equal(state.hermes.pendingProviderChanges.length, 1);
    assert.equal(state.integrations.hermes.pendingProviderChanges.length, 1);

    await markIntegrationProvidersSynced("example");
    const synced = await readIntegrationState();

    assert.equal(await hasPendingProviderChanges("example"), false);
    assert.equal(getIntegrationProviderState(synced, "example").pendingProviderChanges.length, 0);
    assert.equal(synced.hermes.pendingProviderChanges.length, 1);
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

test("hermes robot service adds robots and reports provider/model status", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "claude-opus-4-6" }
    ]);
    await upsertProviderCache("api", { status: "ok", models: ["claude-opus-4-6"], lastCheckedAt: "now", lastError: null });

    const robot = await addHermesRobot({
      name: "robot-a",
      provider: "api",
      model: "claude-opus-4-6",
      telegram: { enabled: true, chatId: "123", name: "telegram" }
    });
    const robots = await listHermesRobots();
    const statuses = await getHermesRobotStatuses();

    assert.equal(robot.name, "robot-a");
    assert.equal(robots.length, 1);
    assert.equal(statuses[0].providerExists, true);
    assert.equal(statuses[0].providerHealth, "ok");
    assert.equal(statuses[0].modelAvailable, true);
    assert.equal(statuses[0].telegram, "configured");
  });
});

test("hermes runtime uses isolated config with selected provider credentials", async () => {
  await withTempHome(async () => {
    const plusProvider = {
      name: "51talk-plus",
      baseUrl: "https://icode.51talk.biz/v1",
      apiKey: "sk-plus-selected",
      mode: "auto",
      level: 1,
      model: "claude-opus-4-6"
    };
    const apiProvider = {
      name: "51talk-api",
      baseUrl: "https://icode.51talk.biz/v1",
      apiKey: "sk-api-should-not-be-used",
      mode: "auto",
      level: 2,
      model: "claude-opus-4-6"
    };
    await writeProviders([plusProvider, apiProvider]);
    const robot = await addHermesRobot({ name: "invest-bot", provider: "51talk-plus", model: "claude-opus-4-6" });

    const runtime = await prepareHermesRuntime(robot, plusProvider, {
      command: "hermes",
      args: ["chat", "--model", robot.model, "--provider", "anthropic", "--source", `ai-gateway:${robot.name}`],
      providerKind: "anthropic",
      baseUrl: "https://icode.51talk.biz"
    });
    const config = await fs.readFile(runtime.configPath, "utf8");

    assert.match(runtime.hermesHome, /hermes\/invest-bot$/);
    assert.equal(runtime.env.HERMES_HOME, runtime.hermesHome);
    assert.equal(runtime.env.ANTHROPIC_API_KEY, "sk-plus-selected");
    assert.equal(runtime.env.AI_GATEWAY_PROVIDER, "51talk-plus");
    assert.match(config, /provider: "anthropic"/);
    assert.match(config, /base_url: "https:\/\/icode\.51talk\.biz"/);
    assert.match(config, /api_key: "sk-plus-selected"/);
    assert.doesNotMatch(config, /sk-api-should-not-be-used/);
  });
});

test("syncHermesRobotToLocalConfig updates native Hermes model config", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    await fs.mkdir(hermesDir, { recursive: true });
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      [
        "toolsets:",
        "  - hermes-cli",
        "model:",
        "  default: old-model",
        "  provider: anthropic",
        "  base_url: https://old.example",
        "  api_key: old-key",
        "terminal:",
        "  backend: local"
      ].join("\n")
    );
    await fs.writeFile(
      path.join(hermesDir, ".env"),
      [
        "ANTHROPIC_API_KEY=sk-old-api",
        "ANTHROPIC_TOKEN=sk-old-token",
        "ANTHROPIC_BASE_URL=https://old.example",
        "OTHER_SETTING=keep"
      ].join("\n")
    );
    await fs.writeFile(
      path.join(hermesDir, "auth.json"),
      JSON.stringify({
        version: 1,
        providers: { "openai-codex": { tokens: { access_token: "secret" } } },
        credential_pool: { copilot: [{ access_token: "secret" }] },
        active_provider: "openai-codex"
      })
    );
    await writeProviders([
      {
        name: "51talk-cs",
        baseUrl: "https://icode.51talk.biz/v1",
        apiKey: "sk-selected-native",
        mode: "auto",
        level: 1,
        model: "claude-sonnet-4-6"
      }
    ]);
    await addHermesRobot({ name: "telegram-bot", provider: "51talk-cs", model: "claude-sonnet-4-6" });
    mockFetchModels(["claude-sonnet-4-6", "claude-opus-4-6"]);

    const result = await syncHermesRobotToLocalConfig("telegram-bot");
    const config = await fs.readFile(path.join(hermesDir, "config.yaml"), "utf8");
    const env = await fs.readFile(path.join(hermesDir, ".env"), "utf8");
    const auth = JSON.parse(await fs.readFile(path.join(hermesDir, "auth.json"), "utf8"));

    assert.equal(result.configPath, path.join(hermesDir, "config.yaml"));
    assert.equal(result.envPath, path.join(hermesDir, ".env"));
    assert.match(config, /toolsets:\n  - hermes-cli/);
    assert.match(config, /terminal:\n  backend: local/);
    assert.match(config, /default: "claude-sonnet-4-6"/);
    assert.match(config, /provider: "51talk-cs"/);
    assert.match(config, /base_url: "https:\/\/icode\.51talk\.biz"/);
    assert.match(config, /api_key: "sk-selected-native"/);
    assert.match(config, /providers:\n  51talk-cs:/);
    assert.match(config, /ai_gateway_managed: true/);
    assert.match(config, /- "claude-sonnet-4-6"/);
    assert.match(config, /- "claude-opus-4-6"/);
    assert.match(config, /custom_providers:\n  - name: "51talk-cs"/);
    assert.match(config, /claude-opus-4-6:\n        context_length: null/);
    assert.doesNotMatch(config, /old-key|old-model|https:\/\/old\.example/);
    assert.match(env, /^ANTHROPIC_API_KEY=$/m);
    assert.match(env, /^ANTHROPIC_BASE_URL=$/m);
    assert.match(env, /^ANTHROPIC_TOKEN=$/m);
    assert.match(env, /^COPILOT_GITHUB_TOKEN=$/m);
    assert.match(env, /OTHER_SETTING=keep/);
    assert.doesNotMatch(env, /sk-selected-native|sk-old-api|sk-old-token/);
    assert.deepEqual(auth.providers, {});
    assert.deepEqual(auth.credential_pool, {});
    assert.equal(auth.active_provider, "");
    assert.equal(result.metadata.modelCounts["51talk-cs"], 2);
  });
});

test("syncHermesRobotToLocalConfig writes OpenAI v1 base URL for chat completions providers", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    await writeProviders([
      {
        name: "51talk-codex",
        baseUrl: "https://icode.51talk.biz",
        apiKey: "sk-codex",
        mode: "auto",
        level: 1,
        model: "gpt-5.5"
      }
    ]);
    await addHermesRobot({ name: "telegram-bot", provider: "51talk-codex", model: "gpt-5.5" });
    mockFetchModels(["gpt-5.5"]);

    await syncHermesRobotToLocalConfig("telegram-bot");
    const config = await fs.readFile(path.join(hermesDir, "config.yaml"), "utf8");

    assert.match(config, /provider: "51talk-codex"/);
    assert.match(config, /base_url: "https:\/\/icode\.51talk\.biz\/v1"/);
    assert.match(config, /api: "https:\/\/icode\.51talk\.biz\/v1"/);
    assert.match(config, /base_url: "https:\/\/icode\.51talk\.biz\/v1"/);
    assert.match(config, /transport: "chat_completions"/);
    assert.match(config, /api_mode: "chat_completions"/);
  });
});

test("syncHermesProvidersToLocalConfig refreshes providers and syncs active Hermes credentials", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    const hermesAgentDir = path.join(tempDir, "hermes-agent");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    process.env.AI_GATEWAY_HERMES_AGENT_DIR = hermesAgentDir;
    await fs.mkdir(hermesDir, { recursive: true });
    await writeHermesModelSwitchFixture(hermesAgentDir);
    await writeHermesGatewayRunFixture(hermesAgentDir);
    await writeHermesRunAgentFixture(hermesAgentDir);
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      [
        "model:",
        "  default: claude-opus-4-6",
        "  provider: 51talk-cs",
        "  base_url: https://icode.51talk.biz",
        "  api_key: sk-active",
        "terminal:",
        "  backend: local"
      ].join("\n")
    );
    await writeProviders([
      {
        name: "51talk-cs",
        baseUrl: "https://icode.51talk.biz",
        apiKey: "sk-selected-native",
        mode: "auto",
        level: 1,
        model: "claude-sonnet-4-6"
      },
      {
        name: "51talk-codex",
        baseUrl: "https://icode.51talk.biz/v1",
        apiKey: "sk-codex",
        mode: "auto",
        level: 2,
        model: "gpt-5.5"
      }
    ]);
    mockFetchModels(["claude-sonnet-4-6", "gpt-5.5"]);

    const result = await syncHermesProvidersToLocalConfig();
    const config = await fs.readFile(path.join(hermesDir, "config.yaml"), "utf8");
    const modelSwitch = await fs.readFile(path.join(hermesAgentDir, "hermes_cli", "model_switch.py"), "utf8");
    const gatewayRun = await fs.readFile(path.join(hermesAgentDir, "gateway", "run.py"), "utf8");
    const runAgent = await fs.readFile(path.join(hermesAgentDir, "run_agent.py"), "utf8");
    const backup = await fs.readFile(path.join(hermesAgentDir, "hermes_cli", "model_switch.py.ai-gateway.bak"), "utf8");

    assert.equal(result.configPath, path.join(hermesDir, "config.yaml"));
    assert.match(config, /default: "claude-opus-4-6"/);
    assert.match(config, /provider: "51talk-cs"/);
    assert.match(config, /api_key: "sk-selected-native"/);
    assert.doesNotMatch(config, /sk-active/);
    assert.match(config, /providers:\n  51talk-cs:/);
    assert.match(config, /  51talk-codex:/);
    assert.match(config, /- "claude-sonnet-4-6"/);
    assert.match(config, /- "gpt-5.5"/);
    assert.equal(result.metadata.modelCounts["51talk-cs"], 2);
    assert.equal(result.metadata.modelCounts["51talk-codex"], 2);
    assert.equal(result.metadata.hermesModelListPatch.status, "patched");
    assert.match(modelSwitch, /AI Gateway: include callable-only user-config model candidates v2/);
    assert.match(modelSwitch, /AI Gateway: restrict picker to managed user providers v1/);
    assert.match(modelSwitch, /def _ai_gateway_managed_user_providers/);
    assert.match(modelSwitch, /configured_models = ep_cfg.get\("models", \[\]\)/);
    assert.match(modelSwitch, /has_configured_models = "models" in ep_cfg/);
    assert.match(modelSwitch, /not has_configured_models or str\(default_model\) in models_list/);
    assert.match(modelSwitch, /has_configured_models and not models_list/);
    assert.match(modelSwitch, /if include_moa and not _ai_gateway_managed_user_providers\(user_providers\):/);
    assert.match(gatewayRun, /AI Gateway: pass gateway user providers into model switch v1/);
    assert.match(gatewayRun, /AI Gateway: persist Telegram picker model switch v1/);
    assert.equal([...gatewayRun.matchAll(/user_providers=user_provs/g)].length, 2);
    assert.match(runAgent, /AI Gateway: drop empty tool call names before chat completions v1/);
    assert.match(runAgent, /def _ai_gateway_drop_empty_tool_call_names/);
    assert.doesNotMatch(backup, /configured_models = ep_cfg/);
  });
});

test("syncHermesProvidersToLocalConfig replaces inline and duplicate provider blocks", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    await fs.mkdir(hermesDir, { recursive: true });
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      [
        "model:",
        "  default: gpt-5.5",
        "  provider: 51talk-codex",
        "  base_url: https://old.test",
        "  api_key: old-key",
        "providers: {}",
        "terminal:",
        "  backend: local",
        "providers:",
        "  stale:",
        "    api_key: stale-key",
        "custom_providers: []"
      ].join("\n")
    );
    await writeProviders([
      {
        name: "51talk-codex",
        baseUrl: "https://icode.51talk.biz",
        apiKey: "sk-codex",
        mode: "auto",
        level: 1,
        model: "gpt-5.5"
      }
    ]);
    mockFetchModels(["gpt-5.5"]);

    await syncHermesProvidersToLocalConfig();
    const config = await fs.readFile(path.join(hermesDir, "config.yaml"), "utf8");

    assert.equal([...config.matchAll(/^providers:/gm)].length, 1);
    assert.equal([...config.matchAll(/^custom_providers:/gm)].length, 1);
    assert.match(config, /providers:\n  51talk-codex:/);
    assert.match(config, /api: "https:\/\/icode\.51talk\.biz\/v1"/);
    assert.match(config, /api_key: "sk-codex"/);
    assert.doesNotMatch(config, /providers: \{\}|stale-key|old-key/);
  });
});

test("repairLocalHermesIntegration patches gateway and refreshes native config without model probes", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    const hermesAgentDir = path.join(tempDir, "hermes-agent");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    process.env.AI_GATEWAY_HERMES_AGENT_DIR = hermesAgentDir;
    process.env.AI_GATEWAY_SKIP_HERMES_RESTART = "1";
    await fs.mkdir(hermesDir, { recursive: true });
    await writeHermesModelSwitchFixture(hermesAgentDir);
    await writeHermesGatewayRunFixture(hermesAgentDir);
    await writeHermesRunAgentFixture(hermesAgentDir);
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      [
        "model:",
        "  default: old-model",
        "  provider: stale-provider",
        "  base_url: https://stale.test",
        "  api_key: stale-key",
        "providers: {}",
        "terminal:",
        "  backend: local"
      ].join("\n")
    );
    await writeProviders([
      {
        name: "51talk-codex",
        baseUrl: "https://icode.51talk.biz",
        apiKey: "sk-codex",
        mode: "auto",
        level: 1,
        model: "gpt-5.5"
      }
    ]);
    await upsertProviderCache("51talk-codex", {
      health: "ok",
      models: ["gpt-5.5"],
      checkedAt: new Date().toISOString()
    });
    await addHermesRobot({ name: "telegram-bot", provider: "51talk-codex", model: "gpt-5.5" });
    mockFetch(() => {
      throw new Error("repair must not probe models");
    });

    const result = await repairLocalHermesIntegration();
    const config = await fs.readFile(path.join(hermesDir, "config.yaml"), "utf8");
    const gatewayRun = await fs.readFile(path.join(hermesAgentDir, "gateway", "run.py"), "utf8");
    const runAgent = await fs.readFile(path.join(hermesAgentDir, "run_agent.py"), "utf8");

    assert.equal(result.configUpdated, true);
    assert.equal(result.hermesModelListPatch.status, "patched");
    assert.equal(result.restart?.method, "skipped");
    assert.match(config, /provider: "51talk-codex"/);
    assert.match(config, /api_key: "sk-codex"/);
    assert.match(config, /providers:\n  51talk-codex:/);
    assert.doesNotMatch(config, /providers: \{\}|stale-key|old-model/);
    assert.equal([...gatewayRun.matchAll(/user_providers=user_provs/g)].length, 2);
    assert.match(runAgent, /AI Gateway: drop empty tool call names before chat completions v1/);

    await upsertProviderCache("51talk-codex", {
      health: "ok",
      models: ["gpt-5.5", "new-cache-only-model"],
      checkedAt: new Date().toISOString()
    });
    const second = await repairLocalHermesIntegration();
    const secondConfig = await fs.readFile(path.join(hermesDir, "config.yaml"), "utf8");
    assert.equal(second.configUpdated, false);
    assert.doesNotMatch(secondConfig, /new-cache-only-model/);
  });
});

test("repairLocalHermesIntegration adopts local Hermes default model into hermes robot config", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    process.env.AI_GATEWAY_SKIP_HERMES_RESTART = "1";
    await fs.mkdir(hermesDir, { recursive: true });
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      [
        "model:",
        "  default: gpt-5.5",
        "  provider: 51talk-codex",
        "  base_url: https://icode.51talk.biz/v1",
        "  api_key: sk-codex",
        "providers:",
        "  51talk-codex:",
        "    name: 51talk-codex",
        "    api: https://icode.51talk.biz/v1",
        "    api_key: sk-codex",
        "    default_model: gpt-5.5",
        "    transport: chat_completions"
      ].join("\n")
    );
    await writeProviders([
      {
        name: "51talk-cs",
        baseUrl: "https://icode.51talk.biz",
        apiKey: "sk-cs",
        mode: "auto",
        level: 1,
        model: "claude-opus-4-6"
      },
      {
        name: "51talk-codex",
        baseUrl: "https://icode.51talk.biz",
        apiKey: "sk-codex",
        mode: "auto",
        level: 2,
        model: "gpt-5.5"
      }
    ]);
    await addHermesRobot({ name: "telegram-bot", provider: "51talk-cs", model: "claude-opus-4-6" });

    const result = await repairLocalHermesIntegration();
    const robots = await listHermesRobots();

    assert.equal(result.robotUpdated, true);
    assert.equal(robots[0].provider, "51talk-codex");
    assert.equal(robots[0].model, "gpt-5.5");
  });
});

test("syncHermesProvidersToLocalConfig writes only callable models", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    await writeProviders([
      {
        name: "api",
        baseUrl: "https://api.test",
        apiKey: "key",
        mode: "auto",
        level: 1,
        model: "claude-good"
      }
    ]);
    mockFetch((url, init) => {
      if (String(url).endsWith("/models")) {
        return jsonResponse({ data: [{ id: "claude-good" }, { id: "claude-bad" }] });
      }
      if (init?.method === "POST" && String(url).endsWith("/v1/messages")) {
        const body = JSON.parse(String(init.body));
        if (body.model === "claude-good") {
          return jsonResponse({ usage: { input_tokens: 1, output_tokens: 1 } });
        }
        return jsonResponse({ error: { message: "model unavailable" } }, { status: 400 });
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await syncHermesProvidersToLocalConfig();
    const config = await fs.readFile(path.join(hermesDir, "config.yaml"), "utf8");
    const usage = JSON.parse(await fs.readFile(path.join(process.env.AI_GATEWAY_HOME, "usage.json"), "utf8"));

    assert.equal(result.metadata.modelCounts.api, 1);
    assert.match(config, /- "claude-good"/);
    assert.doesNotMatch(config, /claude-bad/);
    assert.equal(usage.events[0].source, "model_probe");
    assert.equal(usage.events[0].totalTokens, 2);
  });
});

test("syncHermesProvidersToLocalConfig clears deleted active Hermes provider", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    await fs.mkdir(hermesDir, { recursive: true });
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      [
        "model:",
        "  default: old-model",
        "  provider: deleted-provider",
        "  base_url: https://deleted.test",
        "  api_key: sk-deleted",
        "terminal:",
        "  backend: local"
      ].join("\n")
    );
    await writeProviders([
      {
        name: "remaining",
        baseUrl: "https://remaining.test/v1",
        apiKey: "sk-remaining",
        mode: "auto",
        level: 1,
        model: "gpt-5.5"
      }
    ]);
    mockFetchModels(["gpt-5.5"]);

    await syncHermesProvidersToLocalConfig();
    const config = await fs.readFile(path.join(hermesDir, "config.yaml"), "utf8");

    assert.match(config, /model:\n  default: ""\n  provider: ""\n  base_url: ""\n  api_key: ""/);
    assert.doesNotMatch(config, /deleted-provider|sk-deleted|https:\/\/deleted\.test/);
    assert.match(config, /providers:\n  remaining:/);
  });
});

test("listHermesConfiguredProviders includes AI Gateway and native Hermes providers", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    await fs.mkdir(hermesDir, { recursive: true });
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      [
        "model:",
        "  default: claude-local-active",
        "  provider: native-main",
        "  base_url: https://native-main.test",
        "  api_key: sk-native-main",
        "providers:",
        "  native-main:",
        "    name: native-main",
        "    api: https://native-main.test",
        "    api_key: sk-native-main",
        "    default_model: claude-local-active",
        "    transport: anthropic_messages",
        "    models:",
        "      - claude-local-active",
        "      - claude-local-backup",
        "custom_providers:",
        "  - name: native-custom",
        "    base_url: https://native-custom.test/v1",
        "    api_key: sk-native-custom",
        "    model: gpt-native",
        "    api_mode: chat_completions",
        "    models:",
        "      gpt-native:",
        "        context_length: null"
      ].join("\n")
    );
    await writeProviders([
      {
        name: "gateway",
        baseUrl: "https://gateway.test/v1",
        apiKey: "sk-gateway",
        mode: "auto",
        level: 1,
        model: "gpt-gateway"
      }
    ]);
    await upsertProviderCache("gateway", { status: "ok", models: ["gpt-gateway", "gpt-gateway-plus"], lastCheckedAt: "now", lastError: null });

    const result = await listHermesConfiguredProviders();
    const byName = new Map(result.providers.map((provider) => [provider.name, provider]));

    assert.equal(result.configPath, path.join(hermesDir, "config.yaml"));
    assert.equal(byName.has("gateway"), true);
    assert.equal(byName.has("native-main"), true);
    assert.equal(byName.has("native-custom"), true);
    assert.deepEqual(byName.get("gateway").sources, ["ai-gateway"]);
    assert.deepEqual(byName.get("native-main").sources, ["local-hermes"]);
    assert.equal(byName.get("native-main").active, true);
    assert.equal(byName.get("native-main").defaultModel, "claude-local-active");
    assert.deepEqual(byName.get("native-main").models, ["claude-local-active", "claude-local-backup"]);
    assert.equal(byName.get("native-custom").baseUrl, "https://native-custom.test/v1");
    assert.deepEqual(byName.get("native-custom").models, ["gpt-native"]);
    assert.equal(byName.get("native-custom").apiKeyConfigured, true);
  });
});

test("syncHermesRobotToLocalConfigAndRestart can skip gateway restart in tests", async () => {
  await withTempHome(async (tempDir) => {
    process.env.AI_GATEWAY_SKIP_HERMES_RESTART = "1";
    const hermesDir = path.join(tempDir, "native-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    await writeProviders([
      {
        name: "51talk-cs",
        baseUrl: "https://icode.51talk.biz",
        apiKey: "sk-selected-native",
        mode: "auto",
        level: 1,
        model: "claude-sonnet-4-6"
      }
    ]);
    await addHermesRobot({ name: "telegram-bot", provider: "51talk-cs", model: "claude-sonnet-4-6" });
    mockFetchModels(["claude-sonnet-4-6"]);

    const result = await syncHermesRobotToLocalConfigAndRestart("telegram-bot");

    assert.equal(result.restart.restarted, false);
    assert.equal(result.restart.method, "skipped");
    assert.equal(result.configPath, path.join(hermesDir, "config.yaml"));
  });
});

test("hermes robots are stored in editable hermes.json and can be edited", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "claude-opus-4-6" },
      { name: "api2", baseUrl: "https://api2.test/v1", apiKey: "key2", mode: "auto", level: 2, model: "gpt-5.5" }
    ]);
    await addHermesRobot({ name: "robot-a", provider: "api", model: "claude-opus-4-6" });

    let raw = JSON.parse(await fs.readFile(path.join(process.env.AI_GATEWAY_HOME, "hermes.json"), "utf8"));
    assert.equal(Array.isArray(raw), true);
    assert.equal(raw[0].telegram, undefined);

    const updated = await updateHermesRobot("robot-a", {
      provider: "api2",
      model: "gpt-5.5",
      telegram: { enabled: true, chatId: "123", name: "tester" }
    });
    raw = JSON.parse(await fs.readFile(path.join(process.env.AI_GATEWAY_HOME, "hermes.json"), "utf8"));

    assert.equal(updated.provider, "api2");
    assert.equal(updated.model, "gpt-5.5");
    assert.equal(updated.telegram.chatId, "123");
    assert.equal(raw[0].provider, "api2");
    assert.equal(raw[0].telegram.name, "tester");
    assert.equal(raw[0].createdAt, undefined);
    assert.equal(raw[0].updatedAt, undefined);
    assert.equal(raw[0].source, undefined);
  });
});

test("switchHermesRobotsProvider moves robots to fallback provider and model", async () => {
  await withTempHome(async () => {
    const fallback = { name: "fallback", baseUrl: "https://fallback.test/v1", apiKey: "key2", mode: "auto", level: 1, model: "gpt-5.5" };
    await writeProviders([
      fallback,
      { name: "old", baseUrl: "https://old.test/v1", apiKey: "key", mode: "auto", level: 2, model: "claude-opus-4-6" }
    ]);
    await addHermesRobot({ name: "robot-a", provider: "old", model: "claude-opus-4-6" });

    const count = await switchHermesRobotsProvider("old", fallback);
    const robots = await listHermesRobots();

    assert.equal(count, 1);
    assert.equal(robots[0].provider, "fallback");
    assert.equal(robots[0].model, "gpt-5.5");
  });
});

test("Hermes provider sync is deferred until Hermes commands run", async () => {
  await withTempHome(async (tempDir) => {
    mockFetchModels(["gpt-5.5", "claude-opus-4-6"]);
    process.env.AI_GATEWAY_HERMES_HOME = path.join(tempDir, "local-hermes");
    await writeProviders([
      { name: "fallback", baseUrl: "https://fallback.test/v1", apiKey: "key2", mode: "auto", level: 1, model: "gpt-5.5" },
      { name: "old", baseUrl: "https://old.test/v1", apiKey: "key", mode: "auto", level: 2, model: "claude-opus-4-6" }
    ]);
    await addHermesRobot({ name: "robot-a", provider: "old", model: "claude-opus-4-6" });

    await deleteProvider("old");
    await assert.rejects(() => fs.access(path.join(process.env.AI_GATEWAY_HERMES_HOME, "config.yaml")), /ENOENT/);

    const result = await ensureHermesProviderSync({ restart: false, activeRobotName: "robot-a" });
    const robots = await listHermesRobots();
    const state = await readIntegrationState();
    const config = await fs.readFile(path.join(process.env.AI_GATEWAY_HERMES_HOME, "config.yaml"), "utf8");

    assert.equal(result.changed, true);
    assert.equal(result.switchedRobots, 1);
    assert.equal(robots[0].provider, "fallback");
    assert.equal(robots[0].model, "gpt-5.5");
    assert.equal(state.hermes.pendingProviderChanges.length, 0);
    assert.equal(state.hermes.syncedProviderRevision, state.providerRevision);
    assert.match(config, /provider: "fallback"/);
  });
});

test("Hermes provider sync applies deferred provider renames before fallback", async () => {
  await withTempHome(async (tempDir) => {
    mockFetchModels(["gpt-5.5", "claude-opus-4-6"]);
    process.env.AI_GATEWAY_HERMES_HOME = path.join(tempDir, "local-hermes");
    await writeProviders([
      { name: "fallback", baseUrl: "https://fallback.test/v1", apiKey: "key2", mode: "auto", level: 1, model: "gpt-5.5" },
      { name: "old", baseUrl: "https://old.test/v1", apiKey: "key", mode: "auto", level: 2, model: "claude-opus-4-6" }
    ]);
    await addHermesRobot({ name: "robot-a", provider: "old", model: "claude-opus-4-6" });

    await updateProvider("old", { name: "middle" });
    await updateProvider("middle", { name: "renamed" });
    await assert.rejects(() => fs.access(path.join(process.env.AI_GATEWAY_HERMES_HOME, "config.yaml")), /ENOENT/);

    const result = await ensureHermesProviderSync({ restart: false, activeRobotName: "robot-a" });
    const robots = await listHermesRobots();
    const state = await readIntegrationState();
    const config = await fs.readFile(path.join(process.env.AI_GATEWAY_HERMES_HOME, "config.yaml"), "utf8");

    assert.equal(result.changed, true);
    assert.equal(result.renamedRobots, 1);
    assert.equal(result.switchedRobots, 0);
    assert.equal(robots[0].provider, "renamed");
    assert.equal(robots[0].model, "claude-opus-4-6");
    assert.equal(state.hermes.pendingProviderChanges.length, 0);
    assert.equal(state.hermes.syncedProviderRevision, state.providerRevision);
    assert.match(config, /provider: "renamed"/);
  });
});

test("legacy hermes-robots.json is still readable", async () => {
  await withTempHome(async () => {
    await fs.writeFile(
      path.join(process.env.AI_GATEWAY_HOME, "hermes-robots.json"),
      JSON.stringify({
        robots: [
          {
            name: "legacy",
            provider: "api",
            model: "claude-opus-4-6",
            mode: "auto",
            telegram: { enabled: false, chatId: "", name: "" },
            tasks: [],
            createdAt: "now",
            updatedAt: "now"
          }
        ]
      })
    );

    const robots = await listHermesRobots();
    assert.equal(robots.length, 1);
    assert.equal(robots[0].name, "legacy");
  });
});

test("hermes export defaults to full replication bundle and import restores robots and providers", async () => {
  await withTempHome(async (tempDir) => {
    mockFetchModels(["claude-opus-4-6"]);
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "claude-opus-4-6" }
    ]);
    await upsertProviderCache("api", { status: "ok", models: ["claude-opus-4-6"], lastCheckedAt: "now", lastError: null });
    await fs.writeFile(
      path.join(process.env.AI_GATEWAY_HOME, "hermes.json"),
      JSON.stringify([
        {
          name: "robot-a",
          provider: "api",
          model: "claude-opus-4-6",
          mode: "auto",
          telegram: { enabled: true, chatId: "123", name: "tester" },
          tasks: [
            {
              id: "job-1",
              name: "Morning job",
              type: "cron",
              schedule: "0 9 * * *",
              enabled: true,
              state: "scheduled",
              provider: "api",
              model: "claude-opus-4-6"
            }
          ]
        },
        {
          name: "robot-b",
          provider: "api",
          model: "claude-opus-4-6",
          mode: "auto",
          telegram: { enabled: false, chatId: "", name: "" },
          tasks: []
        }
      ])
    );

    const exportedPath = await exportHermesRobot();
    const exported = await fs.readFile(exportedPath, "utf8");
    assert.match(exported, /"format": "ai-gateway\.hermes-robots\.v2"/);
    assert.match(exported, /robot-a/);
    assert.match(exported, /robot-b/);
    assert.match(exported, /"apiKey": "key"/);
    assert.match(exported, /"providerCache"/);
    assert.match(exported, /"schedule": "0 9 \* \* \*"/);

    process.env.AI_GATEWAY_HOME = path.join(tempDir, "target-home");
    const imported = await importHermesRobot(exportedPath);
    const robots = await listHermesRobots();
    const providers = await readProviders();
    const cache = await readCache();
    assert.equal(imported.robots.length, 2);
    assert.equal(imported.robots[0].action, "created");
    assert.equal(imported.importedProviders.length, 1);
    assert.equal(robots.length, 2);
    assert.equal(robots.some((robot) => robot.name === "robot-a"), true);
    assert.equal(robots.some((robot) => robot.name === "robot-b"), true);
    assert.equal(robots.find((robot) => robot.name === "robot-a").tasks[0].schedule, "0 9 * * *");
    assert.equal(providers.find((provider) => provider.name === "api").apiKey, "key");
    assert.deepEqual(cache.providers.api.models, ["claude-opus-4-6"]);

    const targetHermesDir = path.join(tempDir, "target-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = targetHermesDir;
    await syncHermesRobotToLocalConfig("robot-a");
    const telegram = JSON.parse(await fs.readFile(path.join(targetHermesDir, "channel_directory.json"), "utf8"));
    const cronJobs = JSON.parse(await fs.readFile(path.join(targetHermesDir, "cron", "jobs.json"), "utf8"));
    assert.equal(telegram.platforms.telegram[0].id, "123");
    assert.equal(cronJobs.jobs[0].schedule_display, "0 9 * * *");
    assert.equal(cronJobs.jobs[0].provider, "api");

    const singleExportPath = await exportHermesRobot("robot-a");
    const renamed = await importHermesRobot(singleExportPath, { onConflict: "rename", renameTo: "robot-c" });
    assert.equal(renamed.robots[0].action, "renamed");
    assert.equal(renamed.robots[0].robot.name, "robot-c");

    const badImport = path.join(tempDir, "bad-hermes.json");
    await fs.writeFile(badImport, JSON.stringify({ robot: { name: "bad", provider: "api", model: "x", apiKey: "secret" } }));
    await assert.rejects(() => importHermesRobot(badImport), /must not contain API keys/);

    const badBundleProvider = path.join(tempDir, "bad-hermes-provider.json");
    await fs.writeFile(badBundleProvider, JSON.stringify({
      format: "ai-gateway.hermes-robots.v2",
      robots: [{ name: "robot-x", provider: "api", model: "claude-opus-4-6" }],
      providers: [{ name: "api", baseUrl: "https://api.test/v1", apiKey: "" }]
    }));
    await assert.rejects(() => importHermesRobot(badBundleProvider), /providers\[0\]\.apiKey cannot be empty/);

    const badBundleRobot = path.join(tempDir, "bad-hermes-robot.json");
    await fs.writeFile(badBundleRobot, JSON.stringify({
      format: "ai-gateway.hermes-robots.v2",
      robots: [{ name: "robot-x", provider: "api", model: "claude-opus-4-6", tasks: {} }],
      providers: []
    }));
    await assert.rejects(() => importHermesRobot(badBundleRobot), /robots\[0\]\.tasks must be an array/);
  });
});

test("hermes clear keeps robot config and delete removes it", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "claude-opus-4-6" }
    ]);
    await addHermesRobot({
      name: "robot-a",
      provider: "api",
      model: "claude-opus-4-6",
      mode: "ask",
      telegram: { enabled: true, chatId: "123", name: "tester" }
    });
    const configuredRobots = await listHermesRobots();
    await writeHermesRobots({
      robots: configuredRobots.map((robot) => robot.name === "robot-a"
        ? {
            ...robot,
            tasks: [{
              id: "task-1",
              name: "Morning job",
              type: "cron",
              schedule: "0 9 * * *",
              enabled: true,
              state: "scheduled",
              provider: "api",
              model: "claude-opus-4-6"
            }]
          }
        : robot)
    });
    await fs.mkdir(path.join(hermesDir, "cron"), { recursive: true });
    await fs.writeFile(
      path.join(hermesDir, "cron", "jobs.json"),
      JSON.stringify({
        jobs: [
          { id: "task-1", name: "Cron Task", ai_gateway_robot: "robot-a" },
          { id: "native-task", name: "Native Task" }
        ]
      })
    );
    await upsertHermesRobotState("robot-a", { lastUsedAt: "now", lastSessionId: "ses_1", lastError: "boom" });
    const robotHome = getHermesRobotHome("robot-a");
    await fs.mkdir(robotHome, { recursive: true });
    await fs.writeFile(path.join(robotHome, "memory.json"), JSON.stringify({ messages: ["old"] }));

    await clearHermesRobot("robot-a");
    let robots = await listHermesRobots();
    let state = await readHermesState();
    let cronJobs = JSON.parse(await fs.readFile(path.join(hermesDir, "cron", "jobs.json"), "utf8"));
    assert.equal(robots.length, 1);
    assert.equal(robots[0].provider, "api");
    assert.equal(robots[0].model, "claude-opus-4-6");
    assert.equal(robots[0].mode, "ask");
    assert.equal(robots[0].telegram.chatId, "123");
    assert.equal(robots[0].tasks.length, 0);
    assert.equal(cronJobs.jobs.length, 1);
    assert.equal(cronJobs.jobs[0].id, "native-task");
    assert.equal(state.robots["robot-a"].lastUsedAt, null);
    assert.equal(state.robots["robot-a"].lastError, null);
    assert.equal(Boolean(state.robots["robot-a"].clearedAt), true);
    await assert.rejects(() => fs.access(robotHome), /ENOENT/);

    await deleteHermesRobot("robot-a");
    robots = await listHermesRobots();
    state = await readHermesState();
    assert.equal(robots.length, 0);
    assert.equal(state.robots["robot-a"], undefined);
  });
});

test("imports local Hermes config and cron jobs as robots", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "local-hermes");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    await fs.mkdir(path.join(hermesDir, "cron"), { recursive: true });
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      [
        "model:",
        "  default: claude-opus-4-6",
        "  provider: anthropic",
        "  base_url: https://api.test",
        "  api_key: sk-secret"
      ].join("\n")
    );
    await fs.writeFile(
      path.join(hermesDir, "channel_directory.json"),
      JSON.stringify({
        platforms: {
          telegram: [{ id: "123", name: "tester", type: "dm" }]
        }
      })
    );
    await fs.writeFile(
      path.join(hermesDir, "cron", "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            id: "job123456",
            name: "Cron Robot",
            enabled: true,
            state: "scheduled",
            model: null,
            provider: null,
            schedule_display: "0 9 * * *"
          }
        ]
      })
    );
    await writeProviders([
      { name: "api", baseUrl: "https://api.test", apiKey: "key", mode: "auto", level: 1, model: "claude-opus-4-6" }
    ]);

    const result = await importLocalHermesRobots();
    const robots = await listHermesRobots();
    const providers = await readProviders();
    const cache = await readCache();
    const raw = await fs.readFile(path.join(process.env.AI_GATEWAY_HOME, "hermes.json"), "utf8");

    assert.equal(result.imported.length, 1);
    assert.equal(result.importedProviders.length, 1);
    assert.equal(result.importedProviders[0].name, "anthropic");
    assert.equal(providers.some((provider) => provider.name === "anthropic" && provider.apiKey === "sk-secret"), true);
    assert.deepEqual(cache.providers.anthropic.models, ["claude-opus-4-6"]);
    assert.equal(robots.length, 1);
    assert.equal(robots[0].name, "hermes-default");
    assert.equal(robots[0].provider, "anthropic");
    assert.equal(robots[0].telegram.chatId, "123");
    assert.equal(robots[0].tasks.length, 1);
    assert.equal(robots[0].tasks[0].name, "Cron Robot");
    assert.equal(robots[0].tasks[0].type, "cron");
    assert.doesNotMatch(raw, /sk-secret/);
    assert.doesNotMatch(raw, /createdAt|updatedAt|source/);
    assert.match(raw, /"schedule": "0 9 \* \* \*"/);

    await updateHermesRobot("hermes-default", { name: "capital-sentinel" });
    const secondImport = await importLocalHermesRobots();
    const robotsAfterRename = await listHermesRobots();

    assert.equal(secondImport.imported.length, 0);
    assert.equal(secondImport.skipped.length, 1);
    assert.equal(secondImport.skipped[0].name, "capital-sentinel");
    assert.equal(robotsAfterRename.length, 1);
    assert.equal(robotsAfterRename[0].name, "capital-sentinel");
  });
});

test("parses local Hermes provider records from native config blocks", () => {
  const parsed = parseLocalHermesProviderRecords([
    "model:",
    "  default: claude-opus-4-6",
    "  provider: active-provider",
    "  base_url: https://active.test/v1",
    "  api_key: sk-active",
    "",
    "providers:",
    "  managed:",
    "    name: managed",
    "    api: https://managed.test/v1",
    "    api_key: sk-managed",
    "    default_model: gpt-5.5",
    "    transport: chat_completions",
    "    models:",
    "      - gpt-5.5",
    "      - gpt-5-mini",
    "",
    "custom_providers:",
    "  - name: custom",
    "    base_url: https://custom.test/v1",
    "    api_key: sk-custom",
    "    model: claude-haiku",
    "    api_mode: anthropic_messages",
    "    models:",
    "      claude-haiku:",
    "        context_length: null"
  ].join("\n"));

  const providers = Object.fromEntries(parsed.providers.map((provider) => [provider.name, provider]));

  assert.equal(parsed.activeProvider, "active-provider");
  assert.equal(providers["active-provider"].active, true);
  assert.deepEqual(providers["active-provider"].models, ["claude-opus-4-6"]);
  assert.equal(providers.managed.baseUrl, "https://managed.test/v1");
  assert.equal(providers.managed.apiMode, "chat_completions");
  assert.deepEqual(providers.managed.models, ["gpt-5.5", "gpt-5-mini"]);
  assert.equal(providers.custom.defaultModel, "claude-haiku");
  assert.equal(providers.custom.apiMode, "anthropic_messages");
  assert.deepEqual(providers.custom.models, ["claude-haiku"]);
});

async function withTempHome(fn) {
  const previousHome = process.env.AI_GATEWAY_HOME;
  const previousHermesHome = process.env.AI_GATEWAY_HERMES_HOME;
  const previousHermesAgentDir = process.env.AI_GATEWAY_HERMES_AGENT_DIR;
  const previousSkipHermesRestart = process.env.AI_GATEWAY_SKIP_HERMES_RESTART;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-test-"));
  process.env.AI_GATEWAY_HOME = tempDir;
  process.env.AI_GATEWAY_HERMES_AGENT_DIR = path.join(tempDir, "missing-hermes-agent");
  try {
    await fn(tempDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.AI_GATEWAY_HOME;
    } else {
      process.env.AI_GATEWAY_HOME = previousHome;
    }
    if (previousHermesHome === undefined) {
      delete process.env.AI_GATEWAY_HERMES_HOME;
    } else {
      process.env.AI_GATEWAY_HERMES_HOME = previousHermesHome;
    }
    if (previousHermesAgentDir === undefined) {
      delete process.env.AI_GATEWAY_HERMES_AGENT_DIR;
    } else {
      process.env.AI_GATEWAY_HERMES_AGENT_DIR = previousHermesAgentDir;
    }
    if (previousSkipHermesRestart === undefined) {
      delete process.env.AI_GATEWAY_SKIP_HERMES_RESTART;
    } else {
      process.env.AI_GATEWAY_SKIP_HERMES_RESTART = previousSkipHermesRestart;
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

async function writeHermesModelSwitchFixture(hermesAgentDir) {
  const filePath = path.join(hermesAgentDir, "hermes_cli", "model_switch.py");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      "def list_authenticated_providers(user_providers=None):",
      "    results = []",
      "    if user_providers and isinstance(user_providers, dict):",
      "        for ep_name, ep_cfg in user_providers.items():",
      "            if not isinstance(ep_cfg, dict):",
      "                continue",
      "            display_name = ep_cfg.get(\"name\", \"\") or ep_name",
      "            api_url = ep_cfg.get(\"api\", \"\") or ep_cfg.get(\"url\", \"\") or \"\"",
      "            default_model = ep_cfg.get(\"default_model\", \"\")",
      "",
      "            models_list = []",
      "            if default_model:",
      "                models_list.append(default_model)",
      "",
      "            # Try to probe /v1/models if URL is set (but don't block on it)",
      "            # For now just show what we know from config",
      "            results.append({\"slug\": ep_name, \"models\": models_list, \"api_url\": api_url, \"name\": display_name})",
      "    # Sort: current provider first, then by model count descending",
      "    results.sort(key=lambda r: (not r.get(\"is_current\", False), -r.get(\"total_models\", 0)))",
      "    return results",
      "",
      "def _prepend_moa_picker_provider(providers, current_provider=\"\"):",
      "    return [{\"slug\": \"moa\"}] + providers",
      "",
      "def list_picker_providers(user_providers=None, include_moa=False):",
      "    providers = list_authenticated_providers(user_providers=user_providers)",
      "    if include_moa:",
      "        providers = _prepend_moa_picker_provider(providers)",
      "    return providers",
      ""
    ].join("\n")
  );
}

async function writeHermesGatewayRunFixture(hermesAgentDir) {
  const filePath = path.join(hermesAgentDir, "gateway", "run.py");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      "async def _handle_model_command(self, event):",
      "    user_provs = {'provider': {}}",
      "    async def _on_model_selected(_chat_id, model_id, provider_slug):",
      "                        result = _switch_model(",
      "                            raw_input=model_id,",
      "                            current_provider=_cur_provider,",
      "                            current_model=_cur_model,",
      "                            current_base_url=_cur_base_url,",
      "                            current_api_key=_cur_api_key,",
      "                            is_global=False,",
      "                            explicit_provider=provider_slug,",
      "                        )",
      "                        _self._session_model_overrides[_session_key] = {",
      "                            \"model\": result.new_model,",
      "                            \"provider\": result.target_provider,",
      "                            \"api_key\": result.api_key,",
      "                            \"base_url\": result.base_url,",
      "                            \"api_mode\": result.api_mode,",
      "                        }",
      "",
      "                        # Build confirmation text",
      "        result = _switch_model(",
      "            raw_input=model_input,",
      "            current_provider=current_provider,",
      "            current_model=current_model,",
      "            current_base_url=current_base_url,",
      "            current_api_key=current_api_key,",
      "            is_global=persist_global,",
      "            explicit_provider=explicit_provider,",
      "        )"
    ].join("\n")
  );
}

async function writeHermesRunAgentFixture(hermesAgentDir) {
  const filePath = path.join(hermesAgentDir, "run_agent.py");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      "class AIAgent:",
      "    def _build_api_kwargs(self, api_messages):",
      "        sanitized_messages = api_messages",
      "        needs_sanitization = False",
      "",
      "        # Qwen portal: normalize content to list-of-dicts, inject cache_control.",
      "        # Must run AFTER codex sanitization so we transform the final messages.",
      "        if self._is_qwen_portal():",
      "            pass",
      "        return {\"messages\": sanitized_messages}",
      "",
      "    def _supports_reasoning_extra_body(self) -> bool:",
      "        return False",
      ""
    ].join("\n")
  );
}
