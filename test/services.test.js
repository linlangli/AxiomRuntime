import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addProvider, deleteProvider, updateProvider } from "../dist/core/providers/provider-service.js";
import { readCache, upsertProviderCache } from "../dist/core/config/cache-store.js";
import { readProviders, writeProviders } from "../dist/core/config/providers-store.js";
import { getProviderStatuses } from "../dist/core/status/status-service.js";
import { runDeepDoctor, runDoctor } from "../dist/core/status/doctor-service.js";
import { resolveProviderForTool } from "../dist/core/runner/fallback.js";
import { clearAllSessions, finishSession, getSession, listRecentSessions, startSession } from "../dist/core/sessions/session-service.js";
import { generateSessionReport } from "../dist/core/reports/report-service.js";
import {
  addHermesRobot,
  clearHermesRobot,
  deleteHermesRobot,
  exportHermesRobot,
  getHermesRobotStatuses,
  importHermesRobot,
  importLocalHermesRobots,
  listHermesConfiguredProviders,
  listHermesRobots,
  switchHermesRobotsProvider,
  syncHermesRobotToLocalConfigAndRestart,
  syncHermesRobotToLocalConfig,
  syncHermesProvidersToLocalConfig,
  updateHermesRobot
} from "../dist/core/hermes/hermes-service.js";
import { readHermesState, upsertHermesRobotState } from "../dist/core/hermes/hermes-store.js";
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

test("syncHermesProvidersToLocalConfig refreshes providers and syncs active Hermes credentials", async () => {
  await withTempHome(async (tempDir) => {
    const hermesDir = path.join(tempDir, "native-hermes");
    const hermesAgentDir = path.join(tempDir, "hermes-agent");
    process.env.AI_GATEWAY_HERMES_HOME = hermesDir;
    process.env.AI_GATEWAY_HERMES_AGENT_DIR = hermesAgentDir;
    await fs.mkdir(hermesDir, { recursive: true });
    await writeHermesModelSwitchFixture(hermesAgentDir);
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
    assert.doesNotMatch(backup, /configured_models = ep_cfg/);
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

test("hermes robot import and export omit secrets and support rename", async () => {
  await withTempHome(async (tempDir) => {
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "claude-opus-4-6" }
    ]);
    await addHermesRobot({ name: "robot-a", provider: "api", model: "claude-opus-4-6" });

    const exportedPath = await exportHermesRobot("robot-a");
    const exported = await fs.readFile(exportedPath, "utf8");
    assert.doesNotMatch(exported, /apiKey|key/);
    assert.match(exported, /robot-a/);

    const imported = await importHermesRobot(exportedPath, { onConflict: "rename", renameTo: "robot-b" });
    const robots = await listHermesRobots();
    assert.equal(imported.action, "renamed");
    assert.equal(robots.length, 2);
    assert.equal(robots.some((robot) => robot.name === "robot-b"), true);

    const badImport = path.join(tempDir, "bad-hermes.json");
    await fs.writeFile(badImport, JSON.stringify({ robot: { name: "bad", provider: "api", model: "x", apiKey: "secret" } }));
    await assert.rejects(() => importHermesRobot(badImport), /must not contain API keys/);
  });
});

test("hermes clear keeps robot config and delete removes it", async () => {
  await withTempHome(async () => {
    await writeProviders([
      { name: "api", baseUrl: "https://api.test/v1", apiKey: "key", mode: "auto", level: 1, model: "claude-opus-4-6" }
    ]);
    await addHermesRobot({ name: "robot-a", provider: "api", model: "claude-opus-4-6" });
    await upsertHermesRobotState("robot-a", { lastUsedAt: "now", lastSessionId: "ses_1", lastError: "boom" });

    await clearHermesRobot("robot-a");
    let robots = await listHermesRobots();
    let state = await readHermesState();
    assert.equal(robots.length, 1);
    assert.equal(state.robots["robot-a"].lastUsedAt, null);
    assert.equal(state.robots["robot-a"].lastError, null);
    assert.equal(Boolean(state.robots["robot-a"].clearedAt), true);

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
    assert.doesNotMatch(raw, /"schedule"\s*:/);
  });
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
