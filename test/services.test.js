import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addProvider, deleteProvider, updateProvider } from "../dist/core/providers/provider-service.js";
import { readCache, recordProviderRuntimeFailure, upsertProviderCache } from "../dist/core/config/cache-store.js";
import { readProviders, writeProviders } from "../dist/core/config/providers-store.js";
import { getProviderStatuses } from "../dist/core/status/status-service.js";
import { getExecutionUserDoctorItem, runDeepDoctor, runDoctor } from "../dist/core/status/doctor-service.js";
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
  buildCodexChatGptConfig,
  buildCodexProxyConfig,
  buildCodexProviderConfig,
  listAvailableCodexGptModels,
  normalizeCodexProxy,
  providerIdForName,
  resolveCodexProviderModel,
  scheduleCodexAppRestart,
  setCodexProvider,
  setCodexProxy
} from "../dist/core/integrations/codex-provider-config.js";
import { redactCodexProxyCommandArgs } from "../dist/cli/sanitize-args.js";
import { selectCodexProviderAndModel } from "../dist/cli/commands/set.js";

const ORIGINAL_FETCH = globalThis.fetch;

test("Codex provider config preserves unrelated settings and replaces its managed provider table", () => {
  const current = [
    "model = \"old-model\"",
    "model_provider = \"old-provider\"",
    "",
    "[model_providers.51talk-cq]",
    "name = \"stale\"",
    "base_url = \"https://stale.test/v1\"",
    "",
    "[projects.\"/tmp/project\"]",
    "trust_level = \"trusted\"",
    ""
  ].join("\n");
  const provider = {
    name: "51talk-cq",
    baseUrl: "https://cq.example.com",
    apiKey: "cq-secret",
    mode: "auto",
    level: 1,
    model: "gpt-5.5"
  };

  const updated = buildCodexProviderConfig(current, provider, "51talk-cq", "gpt-5.6-sol");

  assert.match(updated, /^model = "gpt-5\.6-sol"/m);
  assert.match(updated, /^model_provider = "51talk-cq"/m);
  assert.match(updated, /^cli_auth_credentials_store = "file"/m);
  assert.match(updated, /\[model_providers\.51talk-cq\]/);
  assert.match(updated, /base_url = "https:\/\/cq\.example\.com\/v1"/);
  assert.match(updated, /env_key = "OPENAI_API_KEY"/);
  assert.doesNotMatch(updated, /requires_openai_auth/);
  assert.match(updated, /\[projects\."\/tmp\/project"\]/);
  assert.doesNotMatch(updated, /https:\/\/stale\.test/);
  assert.doesNotMatch(updated, /cq-secret/);
  assert.throws(
    () => buildCodexProviderConfig(current, provider, "51talk-cq", "claude-opus-4-6"),
    /must be a GPT model/
  );
});

test("Codex provider config does not duplicate an existing v1 path", () => {
  const updated = buildCodexProviderConfig("", {
    name: "51talk-cq",
    baseUrl: "https://cq.example.com/v1/",
    apiKey: "cq-secret",
    mode: "auto",
    level: 1,
    model: "gpt-5.5"
  }, "51talk-cq");

  assert.match(updated, /base_url = "https:\/\/cq\.example\.com\/v1"/);
  assert.doesNotMatch(updated, /\/v1\/v1/);
});

test("Codex provider model selection keeps only GPT models and picks the newest flagship tier", () => {
  const models = listAvailableCodexGptModels([
    "claude-opus-4-6",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.6-sol",
    "o4-mini"
  ]);

  assert.deepEqual(models, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  assert.equal(resolveCodexProviderModel("51talk-cq", models), "gpt-5.6-sol");
  assert.equal(resolveCodexProviderModel("51talk-cq", models, "GPT-5.6-TERRA"), "gpt-5.6-terra");
  assert.throws(
    () => resolveCodexProviderModel("51talk-cq", models, "claude-opus-4-6"),
    /must be a GPT model/
  );
  assert.throws(
    () => resolveCodexProviderModel("51talk-cq", models, "gpt-5.7-sol"),
    /not available/
  );
  assert.throws(
    () => resolveCodexProviderModel("empty", ["claude-opus-4-6"]),
    /no available GPT models/
  );
});

test("Codex provider model selection prefers a newer GPT family over an older flagship tier", () => {
  assert.equal(
    resolveCodexProviderModel("next", ["gpt-5.6-sol", "gpt-5.7-luna"]),
    "gpt-5.7-luna"
  );
  assert.deepEqual(
    listAvailableCodexGptModels(["gpt-5.6-sol-2026-08-01", "gpt-5.6-sol"]),
    ["gpt-5.6-sol", "gpt-5.6-sol-2026-08-01"]
  );
});

test("interactive Codex provider selection prompts for provider and then GPT model", async () => {
  const providers = [
    { name: "claude-only", baseUrl: "https://a.test/v1", apiKey: "a", mode: "auto", level: 1, model: "claude-opus-4-6" },
    { name: "51talk-cq", baseUrl: "https://b.test/v1", apiKey: "b", mode: "auto", level: 2, model: "gpt-5.5" }
  ];
  const prompts = [];
  const selected = await selectCodexProviderAndModel(providers, {
    "claude-only": { status: "ok", models: ["claude-opus-4-6"], lastCheckedAt: "now", lastError: null },
    "51talk-cq": {
      status: "ok",
      models: ["claude-opus-4-6", "gpt-5.6-sol", "gpt-5.6-terra"],
      lastCheckedAt: "now",
      lastError: null
    }
  }, undefined, undefined, async (message, choices) => {
    prompts.push({ message, choices });
    return (prompts.length === 1 ? "51talk-cq" : "gpt-5.6-terra");
  });

  assert.equal(selected.provider.name, "51talk-cq");
  assert.equal(selected.model, "gpt-5.6-terra");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].message, "Select provider for Codex");
  assert.deepEqual(prompts[1].choices.map((choice) => choice.value), ["gpt-5.6-sol", "gpt-5.6-terra"]);
});

test("named Codex provider auto-selects latest GPT without prompting", async () => {
  const provider = {
    name: "51talk-cq",
    baseUrl: "https://b.test/v1",
    apiKey: "b",
    mode: "auto",
    level: 1,
    model: "gpt-5.5"
  };
  const selected = await selectCodexProviderAndModel([provider], {
    "51talk-cq": {
      status: "ok",
      models: ["gpt-5.5", "gpt-5.6-sol"],
      lastCheckedAt: "now",
      lastError: null
    }
  }, "51talk-cq", undefined, async () => {
    throw new Error("prompt should not run");
  });
  assert.equal(selected.model, "gpt-5.6-sol");
});

test("interactive Codex provider selection fails before prompting when no GPT models exist", async () => {
  const provider = {
    name: "claude-only",
    baseUrl: "https://a.test/v1",
    apiKey: "a",
    mode: "auto",
    level: 1,
    model: "claude-opus-4-6"
  };
  await assert.rejects(
    selectCodexProviderAndModel([provider], {
      "claude-only": {
        status: "ok",
        models: ["claude-opus-4-6"],
        lastCheckedAt: "now",
        lastError: null
      }
    }, undefined, undefined, async () => {
      throw new Error("prompt should not run");
    }),
    /No configured provider has available GPT models/
  );
});

test("Codex ChatGPT config selects the built-in OpenAI provider without removing other tables", () => {
  const updated = buildCodexChatGptConfig([
    "model_provider = \"custom\"",
    "",
    "[features]",
    "multi_agent = true",
    ""
  ].join("\n"));

  assert.match(updated, /^model_provider = "openai"/m);
  assert.match(updated, /^cli_auth_credentials_store = "file"/m);
  assert.match(updated, /\[features\]\nmulti_agent = true/);
});

test("Codex proxy normalization accepts host-port and supports explicit clearing", () => {
  assert.equal(normalizeCodexProxy("127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(normalizeCodexProxy("https://proxy.example.test:8443"), "https://proxy.example.test:8443");
  assert.equal(normalizeCodexProxy("off"), null);
  assert.throws(() => normalizeCodexProxy("socks5://127.0.0.1:7890"), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeCodexProxy("http://user:secret@127.0.0.1:7890"), /credentials/);
  assert.throws(() => normalizeCodexProxy("http://127.0.0.1:7890/path"), /origin only/);
});

test("Codex proxy command arguments are redacted before usage logging", () => {
  assert.deepEqual(
    redactCodexProxyCommandArgs("set", ["codex", "proxy", "http://user:secret@127.0.0.1:7890"]),
    ["codex", "proxy", "[proxy-redacted]"]
  );
  assert.equal(redactCodexProxyCommandArgs("use", ["codex"]), null);
});

test("Codex proxy config preserves unrelated shell environment entries and tables", () => {
  const current = [
    "model_provider = \"openai\"",
    "",
    "[shell_environment_policy.set]",
    "BROWSER = \"chrome\"",
    "HTTP_PROXY = \"http://old:8080\"",
    "",
    "[features]",
    "multi_agent = true",
    ""
  ].join("\n");

  const updated = buildCodexProxyConfig(current, "http://127.0.0.1:7890");
  assert.match(updated, /BROWSER = "chrome"/);
  assert.match(updated, /HTTP_PROXY = "http:\/\/127\.0\.0\.1:7890"/);
  assert.match(updated, /HTTPS_PROXY = "http:\/\/127\.0\.0\.1:7890"/);
  assert.match(updated, /ALL_PROXY = "http:\/\/127\.0\.0\.1:7890"/);
  assert.match(updated, /http_proxy = "http:\/\/127\.0\.0\.1:7890"/);
  assert.match(updated, /\[features\]\nmulti_agent = true/);
  assert.equal((updated.match(/^HTTP_PROXY\s*=/gm) ?? []).length, 1);

  const cleared = buildCodexProxyConfig(updated, null);
  assert.match(cleared, /BROWSER = "chrome"/);
  assert.doesNotMatch(cleared, /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)\s*=/m);
  assert.match(cleared, /\[features\]\nmulti_agent = true/);
});

test("setCodexProxy writes config, applies desktop environment, and schedules restart", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-codex-proxy-"));
  const configPath = path.join(codexHome, "config.toml");
  await fs.writeFile(configPath, "model_provider = \"openai\"\n", { mode: 0o640 });
  let appliedProxy;

  const result = await setCodexProxy("127.0.0.1:7890", {
    codexHome,
    applyProxyEnvironment: async (proxyUrl) => {
      appliedProxy = proxyUrl;
      return { applied: true };
    },
    scheduleRestart: async () => ({ scheduled: true, appPath: "/Applications/ChatGPT.app" })
  });

  const config = await fs.readFile(configPath, "utf8");
  assert.equal(result.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(appliedProxy, "http://127.0.0.1:7890");
  assert.equal(result.restart.scheduled, true);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o640);
  assert.match(config, /\[shell_environment_policy\.set\]/);
});

test("setCodexProxy restores config and skips restart when desktop environment update fails", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-codex-proxy-rollback-"));
  const configPath = path.join(codexHome, "config.toml");
  const original = "model_provider = \"openai\"\n";
  await fs.writeFile(configPath, original, "utf8");
  let restartCalled = false;

  await assert.rejects(setCodexProxy("127.0.0.1:7890", {
    codexHome,
    applyProxyEnvironment: async () => { throw new Error("launchctl failed"); },
    scheduleRestart: async () => {
      restartCalled = true;
      return { scheduled: true };
    }
  }), /launchctl failed/);

  assert.equal(await fs.readFile(configPath, "utf8"), original);
  assert.equal(restartCalled, false);
});

test("clearing an unset Codex proxy does not create an empty config file", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-codex-proxy-empty-"));
  await setCodexProxy("off", {
    codexHome,
    applyProxyEnvironment: async (proxyUrl) => {
      assert.equal(proxyUrl, null);
      return { applied: true };
    },
    scheduleRestart: async () => ({ scheduled: false, reason: "test" })
  });
  await assert.rejects(fs.access(path.join(codexHome, "config.toml")), { code: "ENOENT" });
});

test("setCodexProvider writes custom provider config and Codex-compatible auth atomically", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-codex-provider-"));
  await fs.writeFile(path.join(codexHome, "config.toml"), "model = \"old\"\n[features]\nmulti_agent = true\n", { mode: 0o644 });

  const result = await setCodexProvider({
    type: "provider",
    model: "gpt-5.6-sol",
    provider: {
      name: "51talk-ww-cq",
      baseUrl: "https://ww-cq.example.com/v1",
      apiKey: "provider-secret",
      mode: "auto",
      level: 1,
      model: "gpt-5.5"
    }
  }, {
    codexHome,
    scheduleRestart: async () => ({ scheduled: false, reason: "test" })
  });

  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  const auth = JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"));
  const authMode = (await fs.stat(path.join(codexHome, "auth.json"))).mode & 0o777;
  const configMode = (await fs.stat(path.join(codexHome, "config.toml"))).mode & 0o777;

  assert.equal(result.providerId, "51talk-ww-cq");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.deepEqual(auth, { auth_mode: "apikey", OPENAI_API_KEY: "provider-secret" });
  assert.equal(authMode, 0o600);
  assert.equal(configMode, 0o644);
  assert.match(config, /model_provider = "51talk-ww-cq"/);
  assert.match(config, /^model = "gpt-5\.6-sol"/m);
  assert.match(config, /\[features\]\nmulti_agent = true/);
  assert.doesNotMatch(config, /provider-secret/);
});

test("setCodexProvider accepts Codex-written ChatGPT auth and switches to openai", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-codex-chatgpt-"));
  await fs.writeFile(path.join(codexHome, "config.toml"), "model_provider = \"custom\"\n", "utf8");

  const result = await setCodexProvider({ type: "chatgpt" }, {
    codexHome,
    runChatGptLogin: async ({ codexHome: loginHome }) => {
      assert.equal(loginHome, codexHome);
      await fs.writeFile(path.join(loginHome, "auth.json"), JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          access_token: "access",
          refresh_token: "refresh",
          id_token: "id",
          account_id: "account"
        }
      }), { mode: 0o644 });
      return 0;
    },
    scheduleRestart: async () => ({ scheduled: true, appPath: "/Applications/ChatGPT.app" })
  });

  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  const authMode = (await fs.stat(path.join(codexHome, "auth.json"))).mode & 0o777;
  assert.equal(result.providerId, "openai");
  assert.equal(result.restart.scheduled, true);
  assert.match(config, /^model_provider = "openai"/m);
  assert.equal(authMode, 0o600);
});

test("failed ChatGPT login restores the previous Codex credentials", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-codex-rollback-"));
  const originalConfig = "model_provider = \"old\"\n";
  const originalAuth = `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "old-secret" }, null, 2)}\n`;
  await fs.writeFile(path.join(codexHome, "config.toml"), originalConfig, "utf8");
  await fs.writeFile(path.join(codexHome, "auth.json"), originalAuth, { mode: 0o600 });

  await assert.rejects(
    setCodexProvider({ type: "chatgpt" }, {
      codexHome,
      runChatGptLogin: async ({ codexHome: loginHome }) => {
        await fs.writeFile(path.join(loginHome, "auth.json"), "partial", "utf8");
        return 1;
      },
      scheduleRestart: async () => ({ scheduled: false })
    }),
    /exit code 1/
  );

  assert.equal(await fs.readFile(path.join(codexHome, "config.toml"), "utf8"), originalConfig);
  assert.equal(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"), originalAuth);
});

test("Codex provider ids preserve safe names and isolate reserved or free-form names", () => {
  assert.equal(providerIdForName("51talk-cq"), "51talk-cq");
  assert.match(providerIdForName("openai"), /^ai-openai-[a-f0-9]{8}$/);
  assert.match(providerIdForName("团队 Provider"), /^ai-provider-[a-f0-9]{8}$/);
});

test("Codex app restart scheduler prefers an installed app and detaches the helper", async () => {
  const spawned = [];
  const result = await scheduleCodexAppRestart({
    platform: "darwin",
    appCandidates: ["/Applications/Codex.app", "/Applications/ChatGPT.app"],
    pathExists: async (candidate) => candidate.endsWith("ChatGPT.app"),
    spawnDetached: (command, args) => spawned.push({ command, args })
  });

  assert.equal(result.scheduled, true);
  assert.equal(result.appPath, "/Applications/ChatGPT.app");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.match(spawned[0].args[1], /tell application \\"ChatGPT\\" to quit/);
});

test("Codex app restart scheduler degrades to a manual restart when unsupported or missing", async () => {
  const linux = await scheduleCodexAppRestart({ platform: "linux" });
  const missing = await scheduleCodexAppRestart({
    platform: "darwin",
    appCandidates: ["/Applications/Codex.app"],
    pathExists: async () => false
  });

  assert.equal(linux.scheduled, false);
  assert.match(linux.reason, /macOS only/);
  assert.equal(missing.scheduled, false);
  assert.match(missing.reason, /was not found/);
});

test("doctor reports privileged execution with an actionable non-root recommendation", () => {
  const item = getExecutionUserDoctorItem({ uid: 0 });
  assert.equal(item?.status, "warn");
  assert.match(item?.message ?? "", /constrained to default permissions/);
  assert.match(item?.suggestion ?? "", /dedicated non-root account/);
  assert.equal(getExecutionUserDoctorItem({ uid: 1000 }), null);
});

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
          },
          {
            provider: "api",
            tool: "claude",
            model: "claude-opus-5",
            source: "proxy",
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
            createdAt: new Date().toISOString()
          }
        ]
      })
    );

    const statuses = await getProviderStatuses({ refresh: true });
    assert.equal(statuses[0].health, "ok");
    assert.equal(statuses[0].models.length, 1);
    assert.equal(statuses[0].weeklyTokens, 20);
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
    assert.equal(items.some((item) => item.group === "Providers" && item.status === "ok" && item.message.includes("providers.json")), true);
    assert.equal(items.some((item) => item.group === "Providers" && item.message.includes("api: reachable")), true);
    assert.equal(items.some((item) => item.group === "Local CLIs"), true);
  });
});

test("runDoctor repairs missing runtime files with safe defaults", async () => {
  await withTempHome(async () => {
    const items = await runDoctor({ fix: true, checkProviders: false });
    const runtimeHome = process.env.AI_GATEWAY_HOME;

    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeHome, "providers.json"), "utf8")), []);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeHome, ".ai-cache.json"), "utf8")), { providers: {} });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeHome, "usage.json"), "utf8")), { events: [] });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeHome, "sessions.json"), "utf8")), { sessions: [] });
    assert.equal(items.filter((item) => item.fixed).length >= 4, true);
  });
});

test("runDoctor backs up and rebuilds invalid derived state", async () => {
  await withTempHome(async () => {
    const runtimeHome = process.env.AI_GATEWAY_HOME;
    await fs.writeFile(path.join(runtimeHome, ".ai-cache.json"), "not-json", "utf8");

    const items = await runDoctor({ fix: true, checkProviders: false });
    const cache = JSON.parse(await fs.readFile(path.join(runtimeHome, ".ai-cache.json"), "utf8"));
    const names = await fs.readdir(runtimeHome);

    assert.deepEqual(cache, { providers: {} });
    assert.equal(names.some((name) => name.startsWith(".ai-cache.json.invalid-")), true);
    assert.equal(items.some((item) => item.group === "Cache" && item.fixed), true);
  });
});

test("runDoctor never overwrites invalid provider configuration", async () => {
  await withTempHome(async () => {
    const providersPath = path.join(process.env.AI_GATEWAY_HOME, "providers.json");
    await fs.writeFile(providersPath, "not-json", "utf8");

    const items = await runDoctor({ fix: true, checkProviders: false });

    assert.equal(await fs.readFile(providersPath, "utf8"), "not-json");
    assert.equal(items.some((item) => item.group === "Providers" && item.status === "error"), true);
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
