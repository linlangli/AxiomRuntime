import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import { Response } from "undici";
import { parse } from "smol-toml";
import { desktopDir, desktopRoutes, desktopSecret, getDesktopGatewayStatus, registerDesktopGateway } from "../dist/core/integrations/codex-desktop.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { desktopHandler } from "../dist/server/codex-desktop.js";
import { startLocalWebServer } from "../dist/web/local-server.js";

test("desktop registration, reversible config, scoped catalog and turn routing", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-desktop-"));
  const originalEnv = { ...process.env };
  process.env.AI_GATEWAY_HOME = path.join(root, "runtime");
  process.env.CODEX_HOME = path.join(root, "codex");
  context.after(async () => {
    for (const key of ["AI_GATEWAY_HOME", "CODEX_HOME"]) {
      if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(process.env.CODEX_HOME);
  const file = path.join(process.env.CODEX_HOME, "config.toml");
  const original = '# unchanged\nmodel_provider = "openai"\n[proxy]\nurl = "http://127.0.0.1:7890"\n';
  await fs.writeFile(file, original);
  const auth = path.join(process.env.CODEX_HOME, "auth.json");
  await fs.writeFile(auth, "do not touch");
  const secret = await desktopSecret();
  await registerDesktopGateway(secret);
  await registerDesktopGateway(secret);
  const config = parse(await fs.readFile(file, "utf8"));
  assert.equal(config.model_provider, "axiom-desktop");
  assert.equal(config.model_providers["axiom-desktop"].requires_openai_auth, true);
  const [backup] = (await fs.readdir(desktopDir())).filter(name => name.startsWith("recovery-"));
  execFileSync("bash", [path.join(desktopDir(), backup, "恢复 Codex.command")]);
  assert.equal(await fs.readFile(file, "utf8"), original);
  assert.equal(await fs.readFile(auth, "utf8"), "do not touch");
  await fs.writeFile(path.join(desktopDir(), backup, "config.toml"), "damaged");
  assert.throws(() => execFileSync("bash", [path.join(desktopDir(), backup, "恢复 Codex.command")], { stdio: "pipe" }));
  assert.equal(await fs.readFile(file, "utf8"), original);
  const provider = { name: "Relay", model: "gpt-unit", baseUrl: "https://relay.example/v1", apiKey: "relay-only", level: 0, mode: "auto", codexDesktop: true };
  await writeProviders([provider, { ...provider, name: "Hidden", codexDesktop: false }]);
  const [route] = await desktopRoutes();
  const calls = [];
  const server = http.createServer(desktopHandler(secret, async (url, options) => {
    calls.push({ url: String(url), ...options });
    return Response.json(String(url).includes("/models") ? { models: [{ slug: provider.model, display_name: "Official" }] } : { output: [] });
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const request = (endpoint, body, key = secret) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/v1/" + endpoint,
      method: body ? "POST" : "GET", headers: { host: "127.0.0.1:48567", authorization: "Bearer official-only",
        "chatgpt-account-id": "account", cookie: "private", "x-axiom-desktop": key } }, res => {
      let data = ""; res.on("data", chunk => { data += chunk; }); res.on("end", () => resolve([res.statusCode, JSON.parse(data)]));
    });
    req.on("error", reject); req.end(body && JSON.stringify(body));
  });
  assert.equal((await request("models", undefined, "invalid"))[0], 403);
  assert.equal(calls.length, 0);
  const [status, catalog] = await request("models?client_version=0.169.0");
  assert.equal(status, 200);
  assert.ok(calls.at(-1).dispatcher, "official catalog uses the configured Codex proxy");
  assert.deepEqual(catalog.models.map(model => model.slug), [provider.model, route.alias]);
  for (const model of [provider.model, route.alias, provider.model]) {
    assert.equal((await request("responses", { model, input: ["history"] }))[0], 200);
    const call = calls.at(-1);
    assert.equal(call.redirect, "error");
    assert.deepEqual(JSON.parse(call.body), { model: provider.model, input: ["history"] });
    if (model === route.alias) {
      assert.equal(call.dispatcher, undefined, "Codex proxy does not affect third-party routing");
      assert.equal(call.url, "https://relay.example/v1/responses");
      assert.deepEqual(call.headers, { "content-type": "application/json", Authorization: "Bearer relay-only" });
    } else {
      assert.ok(call.dispatcher, "official inference uses the configured Codex proxy");
      assert.equal(call.url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(call.headers.authorization, "Bearer official-only");
      assert.equal(call.headers["chatgpt-account-id"], "account");
      assert.equal(call.headers["x-axiom-desktop"], undefined);
    }
  }
  await writeProviders([{ ...provider, codexDesktop: false }]);
  assert.equal((await request("responses", { model: route.alias }))[0], 404);
  assert.equal(calls.length, 4);
});

test("Web and CLI separate provider membership from the reversible desktop gateway switch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-desktop-control-"));
  const previousHome = process.env.AI_GATEWAY_HOME;
  const previousCodex = process.env.CODEX_HOME;
  process.env.AI_GATEWAY_HOME = path.join(root, "runtime");
  process.env.CODEX_HOME = path.join(root, "codex");
  let web;
  try {
    await fs.mkdir(process.env.CODEX_HOME);
    const file = path.join(process.env.CODEX_HOME, "config.toml");
    const auth = path.join(process.env.CODEX_HOME, "auth.json");
    const original = 'model = "gpt-unit"\n[features]\nexample = true\n';
    await fs.writeFile(file, original);
    await fs.writeFile(auth, "test-only-auth");
    await writeProviders([{ name: "Nexus Test", model: "gpt-unit", baseUrl: "https://relay.example/v1", apiKey: "relay-only", level: 0, mode: "auto" }]);
    const cli = (...args) => spawnSync(process.execPath, ["dist/cli/index.js", "codex-gateway", ...args], { encoding: "utf8" });
    web = await startLocalWebServer();
    const url = new URL(web.url);
    const request = (endpoint, body) => fetch(`${url.origin}/api/codex/desktop${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${url.hash.slice("#access=".length)}`, origin: url.origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.deepEqual(await (await request("/gateway")).json(), { enabled: false, providerId: "openai" });
    assert.equal((await request("", { name: "Nexus Test", enabled: true })).status, 200);
    assert.match(cli("provider", "list").stdout, /Nexus Test\s+已接入/);
    assert.equal(await fs.readFile(file, "utf8"), original);
    const rejected = await request("/gateway", { enabled: true });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /HTTPS/);
    assert.equal(await fs.readFile(file, "utf8"), original);

    await registerDesktopGateway(await desktopSecret());
    assert.match(cli("status").stdout, /统一网关/);
    assert.equal(cli("off").status, 0);
    assert.deepEqual(await (await request("/gateway")).json(), { enabled: false, providerId: "openai" });
    assert.equal(parse(await fs.readFile(file, "utf8")).features.example, true);
    assert.equal((await desktopRoutes())[0].provider.name, "Nexus Test");
    assert.equal(cli("provider", "off", "Nexus Test").status, 0);
    assert.deepEqual(await desktopRoutes(), []);

    await registerDesktopGateway(await desktopSecret());
    assert.equal((await request("/gateway", { enabled: false })).status, 200);
    assert.equal((await getDesktopGatewayStatus()).enabled, false);
    assert.equal(await fs.readFile(auth, "utf8"), "test-only-auth");
    await fs.writeFile(file, 'model_provider = "custom"\n');
    await assert.rejects(registerDesktopGateway(await desktopSecret()), /其他自定义/);
    assert.equal(cli("off").status, 0);
    assert.equal(await fs.readFile(file, "utf8"), 'model_provider = "custom"\n');
  } finally {
    await web?.close();
    if (previousHome === undefined) delete process.env.AI_GATEWAY_HOME; else process.env.AI_GATEWAY_HOME = previousHome;
    if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
    await fs.rm(root, { recursive: true, force: true });
  }
});
