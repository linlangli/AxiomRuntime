import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-package-smoke-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with `npm run smoke:package`.");
let api;
let web;
let upstream;
const previousHome = process.env.AI_GATEWAY_HOME;
const previousCodex = process.env.CODEX_HOME;

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

try {
  const [packed] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], repository));
  const files = packed.files.map(file => file.path);
  assert.ok(files.includes("dist/web/control/console.html"));
  assert.ok(files.includes("docs/USAGE.html"));
  assert.ok(!files.some(file => file.startsWith("web/dist/portal/")));
  const installation = path.join(temporary, "installed");
  await fs.mkdir(installation);
  npm(["install", "--prefix", installation, "--omit=dev", "--no-audit", "--no-fund", path.join(temporary, packed.filename)], installation);
  const packageRoot = path.join(installation, "node_modules", "@offerpilot", "axiomruntime");
  process.env.AI_GATEWAY_HOME = path.join(temporary, "runtime");
  process.env.CODEX_HOME = path.join(temporary, "codex");
  const version = spawnSync(process.execPath, [path.join(packageRoot, "dist/cli/index.js"), "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /0\.0\./);
  const load = relative => import(pathToFileURL(path.join(packageRoot, relative)).href);
  const { writeProviders } = await load("dist/core/config/providers-store.js");
  const { saveServiceExposure, createServiceCredential } = await load("dist/core/config/service-exposure.js");
  const { startRuntimeServer } = await load("dist/server/runtime-server.js");
  const { startLocalWebServer } = await load("dist/web/local-server.js");
  const { migrateHistoryStorage, backupHistoryStorage, rollbackHistoryStorage } = await load("dist/core/config/history-database.js");
  const { readUsage } = await load("dist/core/config/usage-store.js");
  upstream = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ model: "gpt-smoke", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  await writeProviders([{ name: "smoke", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "isolated-test-key", mode: "ask", level: 1, model: "gpt-smoke" }]);
  await saveServiceExposure({ publicBaseUrl: "", connectionMode: "local", capabilities: ["models", "chat"] });
  const credential = await createServiceCredential("smoke", ["models", "chat"]);
  api = await startRuntimeServer({ port: 0, useExposureConfig: true, agentWorkspaceRoot: path.join(temporary, "workspaces") });
  assert.equal((await fetch(`${api.baseUrl}/health/ready`)).status, 200);
  assert.equal((await fetch(`${api.baseUrl}/v1/models`)).status, 401);
  const response = await fetch(`${api.baseUrl}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-smoke", messages: [{ role: "user", content: "test" }] }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, "ok");
  await api.close(); api = undefined;
  assert.equal((await readUsage()).events.length, 1);
  await migrateHistoryStorage(); await backupHistoryStorage(); await rollbackHistoryStorage();
  assert.equal((await readUsage()).events.length, 1);
  web = await startLocalWebServer({ port: 0 });
  const html = await (await fetch(web.url)).text();
  assert.match(html, /<html/);
  const assets = [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(assets.length >= 2);
  for (const asset of assets) assert.equal((await fetch(new URL(asset, web.url))).status, 200);
  assert.equal((await fetch(new URL("/api/dashboard", web.url))).status, 401);
  console.log("Package smoke passed: isolated npm install, CLI, authenticated API, usage storage backup/rollback, console assets.");
} finally {
  await web?.close(); await api?.close();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  if (previousHome === undefined) delete process.env.AI_GATEWAY_HOME; else process.env.AI_GATEWAY_HOME = previousHome;
  if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
  await fs.rm(temporary, { recursive: true, force: true });
}
