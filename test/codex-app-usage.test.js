import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureCodexAppUsage, getCodexAppUsageConfig, syncCodexAppUsage } from "../dist/core/usage/codex-app-usage.js";
import { appendUsageEvent, appendUsageEvents, readUsage } from "../dist/core/config/usage-store.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { providerIdForName } from "../dist/core/integrations/codex-provider-config.js";
import { getWebDashboard } from "../dist/core/web/dashboard-service.js";
import { applyLocalSettings } from "../dist/core/web/local-settings.js";
import { upsertModelPrice } from "../dist/core/usage/pricing.js";
import { runSetCommand } from "../dist/cli/commands/set.js";

async function isolated(run) {
  const previous = { runtime: process.env.AI_GATEWAY_HOME, codex: process.env.CODEX_HOME };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-codex-usage-"));
  const codexHome = path.join(root, "codex");
  process.env.AI_GATEWAY_HOME = root;
  process.env.CODEX_HOME = codexHome;
  await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true });
  try {
    await writeProviders(["first", "Acme West"].map(name => ({ name, baseUrl: "https://example.test/v1", apiKey: "private-provider-key", model: "gpt-test", level: 0, mode: "auto" })));
    assert.equal((await getCodexAppUsageConfig()).enabled, false);
    await configureCodexAppUsage({ enabled: true });
    const config = await getCodexAppUsageConfig();
    const epoch = Date.parse(config.enabledAt);
    await run({ root, codexHome, config, time: offset => new Date(epoch + offset).toISOString() });
  } finally {
    for (const [name, value] of [["AI_GATEWAY_HOME", previous.runtime], ["CODEX_HOME", previous.codex]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

function metadata(time, provider = "first", extra = {}) {
  return { type: "session_meta", payload: { id: "native-session", timestamp: time(-60_000), originator: "Codex Desktop", source: "vscode", model_provider: provider, base_instructions: "private-prompt-text", ...extra } };
}
function context(model = "gpt-test", provider) {
  return { type: "turn_context", payload: { model, ...(provider ? { model_provider: provider } : {}) } };
}
function tokens(input, output, cached = 0) {
  return { input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: Math.min(3, output), total_tokens: input + output };
}
function usage(time, offset, total, last = total) {
  return { timestamp: time(offset), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } };
}
function lines(events) { return events.map(event => JSON.stringify(event)).join("\n") + "\n"; }
async function session(codexHome, events, name = "session.jsonl") {
  const file = path.join(codexHome, "sessions", name);
  await fs.writeFile(file, lines(events));
  return file;
}
const sync = () => syncCodexAppUsage({ force: true });

test("App counts cumulative deltas by actual Provider/model and uses existing cached-token pricing", () => isolated(async ({ codexHome, time }) => {
  await session(codexHome, [metadata(time), context(), usage(time, -1000, tokens(100, 20, 40)),
    usage(time, 10, tokens(160, 30, 60)), usage(time, 11, tokens(160, 30, 60)),
    { type: "event_msg", payload: { type: "token_count", info: null } },
    context("gpt-next", providerIdForName("Acme West")), usage(time, 20, tokens(200, 40, 70))]);
  await upsertModelPrice("first", "gpt-test", { inputPerMillionUsd: 2, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 1 });
  await Promise.all([sync(), sync(), sync()]);
  const events = (await readUsage()).events;
  assert.deepEqual(events.map(event => [event.provider, event.model, event.inputTokens, event.outputTokens, event.cacheReadInputTokens, event.totalTokens]), [
    ["first", "gpt-test", 60, 10, 20, 70], ["Acme West", "gpt-next", 40, 10, 10, 50]
  ]);
  assert.ok(events.every(event => event.source === "codex_app" && event.tool === "codex" && event.id.startsWith("codex_app:")));
  await sync();
  const dashboard = await getWebDashboard();
  assert.equal(dashboard.usage.totalTokens, 120);
  assert.equal(dashboard.usage.estimatedCostUsd, 0.00014);
  assert.equal(dashboard.providers.find(provider => provider.name === "first").weeklyTokens, 70);
  assert.equal(dashboard.codexUsage.lastError, null);
}));

test("first observed totals use last usage, exclude inherited pre-session history and validate totals", () => isolated(async ({ codexHome, time }) => {
  await session(codexHome, [metadata(time, "first", { timestamp: time(0) }), context(),
    usage(time, -10, tokens(500, 100)), usage(time, 10, tokens(520, 110)),
    usage(time, 20, { ...tokens(530, 115), total_tokens: 99999 })]);
  await session(codexHome, [metadata(time, "first", { id: "fresh" }), context(), usage(time, 10, tokens(10_000, 2000, 500), tokens(100, 30, 20))], "fresh.jsonl");
  const status = await sync();
  assert.deepEqual((await readUsage()).events.map(event => event.totalTokens).sort((left, right) => left - right), [30, 130]);
  assert.equal(status.invalidEvents, 1);
}));

test("unmapped Provider IDs remain visible and replay once after explicit mapping", () => isolated(async ({ codexHome, time }) => {
  await session(codexHome, [metadata(time, "external-id"), context(), usage(time, 10, tokens(80, 20)),
    context("gpt-other", "first"), usage(time, 20, tokens(100, 30))]);
  assert.deepEqual((await sync()).unmappedProviderIds, ["external-id"]);
  assert.deepEqual((await sync()).unmappedProviderIds, ["external-id"]);
  assert.equal((await readUsage()).events.length, 1);
  await configureCodexAppUsage({ enabled: true, providerMappings: { "external-id": "Acme West" } });
  assert.deepEqual((await sync()).unmappedProviderIds, []);
  assert.equal((await readUsage()).events.length, 2);
  assert.equal((await readUsage()).events.find(event => event.provider === "Acme West").totalTokens, 100);
  await assert.rejects(configureCodexAppUsage({ enabled: true, providerMappings: { external: "missing" } }), /已配置/);
  await assert.rejects(configureCodexAppUsage({ enabled: true, providerMappings: { ai_gateway_selected: "first" } }), /Runtime/);
}));

test("Runtime proxy sessions, standalone CLI and SDK sessions are excluded", () => isolated(async ({ codexHome, time }) => {
  for (const [name, provider, extra] of [["proxy", "ai_gateway_selected", {}], ["cli", "first", { originator: "codex_cli_rs", source: "cli" }], ["sdk", "first", { originator: "codex_sdk_ts", source: "exec" }]]) {
    await session(codexHome, [metadata(time, provider, { id: name, ...extra }), context(), usage(time, 10, tokens(10, 5))], `${name}.jsonl`);
  }
  await sync();
  assert.deepEqual((await readUsage()).events, []);
}));

test("partial writes, large transcript lines, corrupt JSON and counter resets never invent usage", () => isolated(async ({ codexHome, time }) => {
  const file = await session(codexHome, [metadata(time), context()]);
  const next = JSON.stringify(usage(time, 10, tokens(100, 20, 40)));
  await fs.appendFile(file, next.slice(0, 70));
  await sync();
  assert.equal((await readUsage()).events.length, 0);
  await fs.appendFile(file, next.slice(70) + "\n");
  await sync();
  await fs.appendFile(file, JSON.stringify({ type: "response_item", payload: { content: "x".repeat(1_100_000) } }) + "\ninvalid json\n");
  await fs.appendFile(file, lines([usage(time, 20, tokens(20, 5)), usage(time, 30, tokens(30, 8, 5)), usage(time, 40, tokens(-1, 2))]));
  const status = await sync();
  assert.deepEqual((await readUsage()).events.map(event => event.totalTokens), [120, 13]);
  assert.equal(status.invalidEvents, 3);
}));

test("archive moves, in-place rewrites and lost cursors preserve idempotency and transcript privacy", () => isolated(async ({ root, codexHome, time }) => {
  const records = [metadata(time), context(), usage(time, 10, tokens(100, 20))];
  const file = await session(codexHome, records);
  await sync();
  await fs.writeFile(file, lines([...records, usage(time, 20, tokens(130, 30))]));
  await sync();
  await fs.mkdir(path.join(codexHome, "archived_sessions"));
  await fs.rename(file, path.join(codexHome, "archived_sessions", "archived.jsonl"));
  await sync();
  await fs.writeFile(path.join(root, "codex-usage-state.json"), "{broken state");
  await sync();
  assert.deepEqual((await readUsage()).events.map(event => event.totalTokens), [120, 40]);
  for (const name of ["usage.json", "codex-usage-state.json", ".ai-gateway.log"]) {
    assert.doesNotMatch(await fs.readFile(path.join(root, name), "utf8"), /private-prompt-text|private-provider-key|base_instructions/);
  }
  const state = await fs.readFile(path.join(root, "codex-usage-state.json"), "utf8");
  assert.doesNotMatch(state, /session\.jsonl|archived\.jsonl/);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(root, "codex-usage-state.json"))).mode & 0o777, 0o600);
}));

test("disabling preserves records and re-enabling excludes the disabled interval", () => isolated(async ({ codexHome, time }) => {
  const file = await session(codexHome, [metadata(time), context(), usage(time, -10, tokens(20, 5))]);
  await configureCodexAppUsage({ enabled: false });
  await fs.appendFile(file, lines([usage(time, -5, tokens(50, 10))]));
  assert.equal((await sync()).enabled, false);
  assert.equal((await readUsage()).events.length, 0);
  await configureCodexAppUsage({ enabled: true });
  await sync();
  assert.equal((await readUsage()).events.length, 0);
  const config = await getCodexAppUsageConfig();
  const newTime = offset => new Date(Date.parse(config.enabledAt) + offset).toISOString();
  await fs.appendFile(file, lines([usage(newTime, 10, tokens(70, 15))]));
  await sync();
  assert.equal((await readUsage()).events[0].totalTokens, 25);
}));

test("configuration and read failures leave the main dashboard and ledger usable", () => isolated(async ({ root, codexHome }) => {
  await assert.rejects(configureCodexAppUsage({ enabled: true, codexHome: "relative" }), /绝对路径/);
  await assert.rejects(configureCodexAppUsage({ enabled: true, codexHome: path.join(root, "missing") }), /不存在/);
  await fs.rm(codexHome, { recursive: true });
  assert.match((await sync()).lastError, /ENOENT/);
  await fs.writeFile(path.join(root, "codex-usage.json"), "{broken");
  const dashboard = await getWebDashboard();
  assert.equal(dashboard.usage.totalTokens, 0);
  assert.ok(dashboard.codexUsage.lastError);
  await fs.mkdir(codexHome);
  await configureCodexAppUsage({ enabled: true, codexHome });
  assert.equal((await sync()).lastError, null);
}));

test("bounded scans resume across oversized transcript lines and never store their contents", () => isolated(async ({ codexHome, time }) => {
  const file = await session(codexHome, [metadata(time), context()]);
  await fs.appendFile(file, JSON.stringify({ type: "response_item", payload: "x".repeat(9 * 1024 * 1024) }) + "\n" + lines([usage(time, 10, tokens(12, 3))]));
  await sync();
  assert.equal((await readUsage()).events.length, 0);
  await sync();
  assert.equal((await readUsage()).events[0].totalTokens, 15);
}));

test("batch ledger writes deduplicate IDs atomically and preserve ordinary proxy events", () => isolated(async () => {
  const event = { provider: "first", tool: "codex", model: "gpt-test", source: "proxy", inputTokens: 5, outputTokens: 2, totalTokens: 7, createdAt: new Date().toISOString() };
  await appendUsageEvent(event);
  await appendUsageEvent(event);
  const identified = { ...event, id: "codex_app:test", source: "codex_app" };
  await Promise.all([appendUsageEvents([identified, identified]), appendUsageEvents([identified])]);
  assert.equal((await readUsage()).events.length, 3);
}));

test("Web and CLI use shared collection settings without changing native Codex configuration", () => isolated(async ({ root, codexHome }) => {
  const file = path.join(codexHome, "config.toml");
  await fs.writeFile(file, 'model_provider = "first"\n');
  await applyLocalSettings({ action: "codex-usage", enabled: false, codexHome, providerMappings: {} });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await runSetCommand(["codex", "usage", "on"]);
    await runSetCommand(["codex", "usage", "map", "openai", "first"]);
    await runSetCommand(["codex", "usage", "status"]);
    await assert.rejects(runSetCommand(["codex", "usage", "on", "extra"]), /Usage:/);
  } finally { console.log = originalLog; }
  assert.equal((await getCodexAppUsageConfig()).providerMappings.openai, "first");
  assert.equal(await fs.readFile(file, "utf8"), 'model_provider = "first"\n');
  assert.equal((await fs.readdir(root)).includes("web-backups"), false);
}));
