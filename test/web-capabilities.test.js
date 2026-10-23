import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import { callService, serviceVerification } from "../dist/core/web/service-playground.js";
import { prepareSsh, runSshCommand } from "../dist/core/services/ssh-setup.js";
import { controlBot } from "../dist/core/services/bot-service.js";
import { migrateLegacyConfig } from "../dist/telegram/bot-registry.js";
import { getTelegramBotConfigPath, getTelegramBotDbPath, getTelegramBotPidPath, getTelegramConfigPath } from "../dist/core/config/paths.js";
import { executeRuntimeTool } from "../dist/core/services/runtime-tools.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const { Server: SshServer } = ssh2;
import { saveServiceExposure, createServiceCredential, rotateServiceCredential, loadServiceExposure, findServiceCredential, validateCredentialPolicy } from "../dist/core/config/service-exposure.js";
import { admitServiceRequest } from "../dist/core/services/credential-policy.js";
import { queryWebHistory, historyCsv } from "../dist/core/web/history-service.js";
import { writeLog } from "../dist/core/logs/log-service.js";
import { startRuntimeServer } from "../dist/server/runtime-server.js";
import { startLocalWebServer } from "../dist/web/local-server.js";
import { applyClaudeSettings, getClaudeSettings } from "../dist/core/web/claude-settings.js";
import { deploymentPlan } from "../dist/core/services/remote-deployment.js";
import { writeProviders } from "../dist/core/config/providers-store.js";
import { writeJsonFile } from "../dist/core/config/json-store.js";
import { createSettingsBackup, applyLocalSettings } from "../dist/core/web/local-settings.js";
import { createApiServiceManager } from "../dist/core/services/api-service.js";

async function isolated(run) {
  const previous = { runtime: process.env.AI_GATEWAY_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-web-complete-"));
  process.env.AI_GATEWAY_HOME = root; process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  try { await run(root); } finally {
    if (previous.runtime === undefined) delete process.env.AI_GATEWAY_HOME; else process.env.AI_GATEWAY_HOME = previous.runtime;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("credential policies validate, expire and rotate without reactivating old tokens or resetting request quota", () => isolated(async () => {
  await saveServiceExposure({ publicBaseUrl: "", connectionMode: "local", capabilities: ["models", "tools"] });
  assert.throws(() => validateCredentialPolicy({ requestQuota: -1 }), /正整数/);
  assert.throws(() => validateCredentialPolicy({ expiresAt: "yesterday" }), /有效期/);
  assert.throws(() => validateCredentialPolicy({ models: [5] }), /白名单/);
  const created = await createServiceCredential("caller", ["models"], { requestQuota: 2 });
  const config = await loadServiceExposure(); const credential = findServiceCredential(config, created.token);
  const admissions = await Promise.all(Array.from({ length: 5 }, () => admitServiceRequest(credential)));
  assert.equal(admissions.filter(Boolean).length, 2);
  const rotated = await rotateServiceCredential(created.id);
  assert.equal(findServiceCredential(await loadServiceExposure(), created.token), null);
  assert.equal(await admitServiceRequest(findServiceCredential(await loadServiceExposure(), rotated.token)), false);
  credential.policy = { expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(findServiceCredential(config, created.token), null);
}));

test("runtime enforces scoped model catalog, registered tools, rate limit and provider restrictions", () => isolated(async root => {
  await writeProviders([{ name: "allowed", baseUrl: "http://127.0.0.1:1", apiKey: "private-key", model: "gpt-allowed", mode: "ask", level: 1 }, { name: "other", baseUrl: "http://127.0.0.1:2", apiKey: "secret", model: "gpt-denied", mode: "ask", level: 2 }]);
  await saveServiceExposure({ publicBaseUrl: "", connectionMode: "local", capabilities: ["models", "tools", "chat", "agent"] });
  const scoped = await createServiceCredential("scoped", ["models", "tools", "chat", "agent"], { providers: ["allowed"], models: ["gpt-allowed"] });
  const limited = await createServiceCredential("limited", ["models"], { requestsPerMinute: 1 });
  const server = await startRuntimeServer({ port: 0, useExposureConfig: true, agentWorkspaceRoot: path.join(root, "workspaces") });
  const call = (route, body, token = scoped.token) => fetch(server.baseUrl + route, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.deepEqual((await (await call("/v1/models")).json()).data.map(item => item.id), ["gpt-allowed"]);
    const tools = await call("/v1/tools/execute", { name: "providers.list" });
    const result = await tools.text(); assert.match(result, /allowed/); assert.doesNotMatch(result, /private-key|secret|other/);
    assert.equal((await call("/v1/tools/execute", { name: "shell.exec", command: "touch /tmp/escape" })).status, 400);
    assert.equal((await call("/v1/chat/completions", { model: "gpt-denied", messages: [] })).status, 403);
    assert.equal((await call("/v1/agent/runs", { engine: "codex", prompt: "hi", workspace_id: "test", provider: "other", model: "gpt-allowed" })).status, 403);
    assert.equal((await call("/v1/models", null, limited.token)).status, 200);
    assert.equal((await call("/v1/models", null, limited.token)).status, 429);
  } finally { await server.close(); }
}));

test("Claude persistent settings preserve unrelated fields, back up secrets locally and redact status", () => isolated(async root => {
  await writeProviders([{ name: "test", baseUrl: "https://example.test/v1", apiKey: "private-key", model: "claude-model", mode: "ask", level: 1 }]);
  const file = path.join(root, "claude/settings.json"); await writeJsonFile(file, { permissions: { deny: ["Bash"] }, env: { KEEP_ME: "yes", ANTHROPIC_AUTH_TOKEN: "old" } });
  await applyClaudeSettings({ provider: "test", model: "claude-new" });
  const config = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(config.permissions, { deny: ["Bash"] }); assert.equal(config.env.KEEP_ME, "yes"); assert.equal(config.env.ANTHROPIC_API_KEY, "private-key"); assert.equal(config.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify(await getClaudeSettings()), /private-key|"old"/);
  assert.ok((await fs.readdir(path.dirname(file))).some(name => name.includes("axiom-backup")));
  await applyClaudeSettings({ action: "clear", provider: "test" });
  assert.equal((await getClaudeSettings()).credentialConfigured, false);
}));

test("history pagination covers older rows, excludes secrets, and escapes spreadsheet formulas", () => isolated(async () => {
  for (let index = 0; index < 310; index++) await writeLog({ category: "provider", action: `event_${index}`, message: "secret prompt", metadata: { apiKey: "sensitive-key", provider: "test" } });
  const first = await queryWebHistory(new URLSearchParams({ limit: "200" }));
  const second = await queryWebHistory(new URLSearchParams({ limit: "200", offset: "200" }));
  assert.equal(first.total, 310); assert.equal(first.items.length, 200); assert.equal(second.items.length, 110);
  assert.doesNotMatch(JSON.stringify(first), /sensitive-key|secret prompt/);
  assert.match(historyCsv([{ model: '=HYPERLINK("evil")' }]), /'=HYPERLINK/);
  await assert.rejects(queryWebHistory(new URLSearchParams({ offset: "-1" })), /分页/);
}));

test("new Web mutation routes require local auth and Origin and validate inputs", () => isolated(async () => {
  const server = await startLocalWebServer(); const url = new URL(server.url); const token = url.hash.slice("#access=".length);
  try {
    for (const route of ["/api/claude", "/api/bots/control", "/api/exposure/ssh-setup", "/api/exposure/deployment", "/api/exposure/call", "/api/exposure/credentials/test/rotate"]) {
      assert.equal((await fetch(url.origin + route, { method: "POST" })).status, 401);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "https://evil.test" };
      assert.equal((await fetch(url.origin + route, { method: "POST", headers, body: "{}" })).status, 403);
      headers.Origin = url.origin;
      assert.equal((await fetch(url.origin + route, { method: "POST", headers, body: "{}" })).status, 400);
    }
  } finally { await server.close(); }
}));

test("SSH connection config enters restricted snapshots while admission counters do not roll back", () => isolated(async root => {
  const original = { host: "server.test", user: "root", port: 22, identityFile: "/tmp/key" };
  await writeJsonFile(path.join(root, "ssh-tunnel.json"), original);
  await writeJsonFile(path.join(root, "service-admission.json"), { quota: 10 });
  const backup = await createSettingsBackup();
  await writeJsonFile(path.join(root, "ssh-tunnel.json"), { ...original, host: "changed.test" });
  await writeJsonFile(path.join(root, "service-admission.json"), { quota: 20 });
  await applyLocalSettings({ action: "restore", id: backup.id });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "ssh-tunnel.json"))), original);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "service-admission.json"))), { quota: 20 });
}));

test("remote deployment generates scoped fixed-upstream plans and rejects unsafe domain and email", () => isolated(async root => {
  await saveServiceExposure({ publicBaseUrl: "https://api.example.test", connectionMode: "ssh", capabilities: ["images"] });
  await writeJsonFile(path.join(root, "ssh-tunnel.json"), { host: "server.test", user: "root", port: 22, identityFile: "/tmp/key" });
  const plan = await deploymentPlan("admin@example.test", false);
  assert.match(plan.script, /trap cleanup EXIT/); assert.match(plan.config, /127\.0\.0\.1:18080/); assert.match(plan.config, /images\/generations/); assert.doesNotMatch(plan.config, /agent\/runs|8021/);
  assert.doesNotMatch(plan.script, /apt-get install/);
  assert.match((await deploymentPlan("admin@example.test", true)).script, /apt-get install/);
  await assert.rejects(deploymentPlan("$(touch /tmp/escape)", true), /邮箱/);
  await saveServiceExposure({ publicBaseUrl: "https://127.0.0.1", connectionMode: "ssh", capabilities: ["images"] });
  await assert.rejects(deploymentPlan("admin@example.test", false), /域名/);
}));

test("Windows service uses encoded PowerShell and Task Scheduler without storing service tokens", () => isolated(async () => {
  await saveServiceExposure({ publicBaseUrl: "", connectionMode: "local", capabilities: ["models"] }); await createServiceCredential("test", ["models"]);
  const scripts = []; let installed = false; let running = false; let autostart = false;
  const manager = createApiServiceManager({ platform: "win32", run: async (command, args) => {
    assert.equal(command, "powershell.exe"); assert.ok(args.includes("-EncodedCommand"));
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le"); scripts.push(script);
    if (script.includes("ConvertTo-Json")) return JSON.stringify({ installed, running, autostart });
    if (script.includes("New-ScheduledTaskAction")) { installed = true; autostart = script.includes("New-ScheduledTaskTrigger"); }
    if (script.includes("Stop-ScheduledTask")) running = false;
    if (script.includes("Start-ScheduledTask")) running = true;
    if (script.includes("RemoveAll")) autostart = false;
    return "";
  } });
  assert.equal((await manager.control("enable")).running, true); assert.equal((await manager.status()).autostart, true);
  assert.equal((await manager.control("disable")).running, true); assert.equal((await manager.status()).autostart, false);
  assert.equal((await manager.control("stop")).running, false);
  assert.doesNotMatch(scripts.join("\n"), /axm_/); assert.match(scripts.join("\n"), /Interactive/);
}));

test("playground uses the existing API, validates responses, forwards multipart and invalidates public proof", () => isolated(async root => {
  await saveServiceExposure({ publicBaseUrl: "https://api.example.test", connectionMode: "ssh", capabilities: ["models", "image_edits"] });
  const credential = await createServiceCredential("test", ["models"]);
  const input = { capability: "models", target: "public", token: credential.token };
  let calls = 0;
  const transport = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.example.test/v1/models");
    assert.equal(options.headers.Authorization, `Bearer ${credential.token}`);
    assert.equal(options.redirect, "error");
    return Response.json({ data: [] });
  };
  assert.equal((await callService(input, async () => new Response("<html>Wrong site</html>"))).ok, false);
  assert.equal((await serviceVerification()).verified, false);
  assert.equal((await callService(input, transport)).verified, true);
  assert.equal(calls, 1);
  assert.equal((await serviceVerification()).verified, true);
  assert.doesNotMatch(await fs.readFile(path.join(root, "service-verification.json"), "utf8"), new RegExp(credential.token));
  await rotateServiceCredential(credential.id);
  assert.equal((await serviceVerification()).verified, false);
  assert.equal((await callService(input, async () => {
    await rotateServiceCredential(credential.id);
    return Response.json({ data: [] });
  })).verified, false);
  const image = Buffer.from("test-image-content");
  const result = await callService({ capability: "image_edits", target: "local", token: "temporary-token", body: { model: "image-model", prompt: "private-prompt", images: [{ type: "image/png", data: image.toString("base64") }] } }, async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8080/v1/images/edits");
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get("prompt"), "private-prompt");
    assert.deepEqual(Buffer.from(await options.body.get("image").arrayBuffer()), image);
    assert.equal(options.headers["Content-Type"], undefined);
    return Response.json({ data: [{ b64_json: "output" }] });
  });
  assert.equal(result.ok, true); assert.equal(result.verified, false);
  await assert.rejects(callService({ ...input, capability: "chat" }, transport), /先开放/);
  await assert.rejects(callService({ ...input, target: "https://other.test" }, transport), /目标/);
  await assert.rejects(callService({ ...input, token: "bad\r\nheader" }, transport), /凭证/);
  assert.doesNotMatch(await fs.readFile(path.join(root, "service-exposure.json"), "utf8"), /private-prompt|temporary-token|test-image-content/);
}));

test("SSH preparation requires confirmed host identity and pins password bootstrap to trusted host keys", () => isolated(async root => {
  const hostFile = path.join(root, "host-key");
  await runSshCommand("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostFile]);
  const hostPublic = (await fs.readFile(`${hostFile}.pub`, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
  let executed = "";
  const connections = new Set();
  const server = new SshServer({ hostKeys: [await fs.readFile(hostFile)] }, client => {
    connections.add(client); client.on("close", () => connections.delete(client)); client.on("error", () => undefined);
    client.on("authentication", context => context.method === "password" && context.username === "test" && context.password === "transient-password" ? context.accept() : context.reject());
    client.on("ready", () => client.on("session", accept => accept().on("exec", (acceptCommand, reject, info) => {
      executed = info.command; const stream = acceptCommand(); stream.exit(0); stream.end();
    })));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { host: "127.0.0.1", port: server.address().port, user: "test", identityFile: path.join(root, "service-ssh-key") };
  const dependencies = { home: root, run: async (command, args, input, timeout) => command === "ssh-keyscan" ? `[127.0.0.1]:${config.port} ${hostPublic}\n` : runSshCommand(command, args, input, timeout) };
  try {
    await assert.rejects(prepareSsh({ action: "trust", config, scanId: "unconfirmed" }, dependencies), /过期/);
    const generated = await prepareSsh({ action: "keygen", config }, dependencies);
    assert.match(generated.publicKey, /^ssh-ed25519 /); assert.doesNotMatch(JSON.stringify(generated), /PRIVATE KEY/);
    assert.equal((await fs.stat(generated.identityFile)).mode & 0o077, 0);
    const scan = await prepareSsh({ action: "scan", config }, dependencies);
    assert.match(scan.fingerprints, /SHA256:/);
    await assert.rejects(prepareSsh({ action: "trust", config: { ...config, host: "other.test" }, scanId: scan.scanId }, dependencies), /改变/);
    await prepareSsh({ action: "trust", config, scanId: scan.scanId }, dependencies);
    await prepareSsh({ action: "authorize", config, password: "transient-password" }, dependencies);
    assert.match(executed, /authorized_keys/); assert.match(executed, /ssh-ed25519/); assert.doesNotMatch(executed, /transient-password/);
    const known = path.join(root, ".ssh/known_hosts");
    await fs.writeFile(known, `[127.0.0.1]:${config.port} ${(await fs.readFile(`${generated.identityFile}.pub`, "utf8")).trim()}\n`);
    await assert.rejects(prepareSsh({ action: "authorize", config, password: "transient-password" }, dependencies), /授权失败/);
    const conflict = await prepareSsh({ action: "scan", config }, dependencies);
    await assert.rejects(prepareSsh({ action: "trust", config, scanId: conflict.scanId }, dependencies), /冲突/);
  } finally {
    for (const connection of connections) connection.end();
    await new Promise(resolve => server.close(resolve));
  }
}));

test("Bot controls reject unrelated PIDs and deletion preserves data without resurrecting legacy defaults", () => isolated(async () => {
  await writeJsonFile(getTelegramBotConfigPath("default"), { token: "", allowedUserIds: [] });
  await writeJsonFile(getTelegramConfigPath(), { token: "legacy" });
  await fs.writeFile(getTelegramBotDbPath("default"), "session-data");
  await fs.writeFile(getTelegramBotPidPath("default"), String(process.pid));
  await assert.rejects(controlBot("default", "stop"), /拒绝发送信号/);
  assert.equal(await fs.readFile(getTelegramBotConfigPath("default"), "utf8").then(Boolean), true);
  await fs.rm(getTelegramBotPidPath("default"));
  await assert.rejects(controlBot("default", "start"), /Token/);
  await controlBot("default", "delete");
  assert.equal(await fs.readFile(getTelegramBotDbPath("default"), "utf8"), "session-data");
  await migrateLegacyConfig();
  await assert.rejects(fs.access(getTelegramBotConfigPath("default")), /ENOENT/);
  await assert.rejects(controlBot("../escape", "stop"), /名称/);
}));

test("Claude rejects unknown operations and malformed environments, and tools hide out-of-scope models", () => isolated(async root => {
  await writeProviders([{ name: "test", baseUrl: "https://example.test/v1", apiKey: "secret", model: "hidden-model", mode: "ask", level: 1 }]);
  await assert.rejects(applyClaudeSettings({ action: "unknown", provider: "test" }), /操作/);
  const file = path.join(root, "claude/settings.json"); await writeJsonFile(file, { env: "invalid" });
  await assert.rejects(applyClaudeSettings({ action: "provider", provider: "test" }), /格式/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { env: "invalid" });
  assert.deepEqual(await executeRuntimeTool("providers.list", ["test"], ["allowed-model"]), []);
}));

test("remote deployment script installs only an owned site and restores its previous config on certificate failure", () => isolated(async root => {
  await saveServiceExposure({ publicBaseUrl: "https://api.example.test", connectionMode: "ssh", capabilities: ["images"] });
  await writeJsonFile(path.join(root, "ssh-tunnel.json"), { host: "server.test", user: "root", port: 22, identityFile: "/tmp/key" });
  const plan = await deploymentPlan("admin@example.test", false);
  const remote = path.join(root, "remote"); const binaries = path.join(remote, "bin");
  await fs.mkdir(binaries, { recursive: true }); await fs.mkdir(path.join(remote, "var/lock"), { recursive: true });
  const destination = path.join(remote, "etc/nginx/conf.d/axiom-runtime-api.example.test.conf");
  const script = plan.script.replaceAll("/etc/", `${remote}/etc/`).replaceAll("/var/lib/", `${remote}/var/lib/`).replaceAll("/var/lock/", `${remote}/var/lock/`);
  const scriptPath = path.join(remote, "deploy.sh"); await fs.writeFile(scriptPath, script);
  const stubs = {
    id: "printf '0\\n'",
    flock: "exit 0",
    nginx: 'if test "$1" = -T; then printf "server { listen 80; server_name ${UNMANAGED_DOMAIN:-other.example.test}; }\\n"; fi; exit 0',
    systemctl: 'if test "$1" = list-unit-files; then printf "certbot-renew.timer enabled\\n"; fi; exit 0',
    certbot: 'test "${FAIL_CERTIFICATE:-}" != yes',
  };
  for (const [name, body] of Object.entries(stubs)) await fs.writeFile(path.join(binaries, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  const execute = promisify(execFile);
  const env = { ...process.env, PATH: `${binaries}:${process.env.PATH}` };
  await execute("sh", ["-n", scriptPath]);
  await execute("sh", [scriptPath], { env });
  const previous = await fs.readFile(destination, "utf8");
  assert.match(previous, /ssl_certificate/); assert.match(previous, /127\.0\.0\.1:18080/);
  await assert.rejects(execute("sh", [scriptPath], { env: { ...env, FAIL_CERTIFICATE: "yes" } }));
  assert.equal(await fs.readFile(destination, "utf8"), previous);
  await fs.rm(destination + ".axiom-owner");
  await assert.rejects(execute("sh", [scriptPath], { env }));
  assert.equal(await fs.readFile(destination, "utf8"), previous);
  await fs.rm(destination);
  await assert.rejects(execute("sh", [scriptPath], { env: { ...env, UNMANAGED_DOMAIN: "api.example.test" } }));
  await assert.rejects(fs.access(destination), /ENOENT/);
}));
