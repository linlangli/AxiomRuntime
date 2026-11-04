import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSshTunnelManager, validateSshTunnel, managedTunnelArgs, loadSshTunnel } from "../dist/core/services/ssh-tunnel.js";
import { createApiServiceManager } from "../dist/core/services/api-service.js";
import { saveServiceExposure, loadServiceExposure, createServiceCredential, checkServiceConnection } from "../dist/core/config/service-exposure.js";
import http from "node:http";

const config = { host: "154.201.73.41", user: "root", port: 22, identityFile: path.resolve("test-key") };

test("SSH tunnel validates input and fixes forwarding, trust and noninteractive authentication", () => {
  assert.deepEqual(validateSshTunnel(config), config);
  for (const value of [null, [], { ...config, host: "-oProxyCommand=bad" }, { ...config, host: "host;touch x" }, { ...config, user: "root@other" }, { ...config, port: "22" }, { ...config, port: 65536 }, { ...config, identityFile: "relative" }, { ...config, identityFile: "/tmp/key\ncommand" }]) assert.throws(() => validateSshTunnel(value));
  const args = managedTunnelArgs(config);
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("PasswordAuthentication=no"));
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.ok(args.includes("ForwardAgent=no"));
  assert.equal(args[args.indexOf("-R") + 1], "127.0.0.1:18080:127.0.0.1:8080");
  assert.equal(args.at(-1), config.host);
});

for (const platform of ["darwin", "linux"]) {
  test(`${platform} tunnel lifecycle uses independent background service and validates remote health`, async () => {
    const previous = process.env.AI_GATEWAY_HOME;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-tunnel-test-"));
    process.env.AI_GATEWAY_HOME = root;
    const calls = [];
    const states = new Map();
    let remoteOk = true;
    const deps = { platform, home: root, run: async (command, args) => {
      calls.push([command, args]);
      if (command === "ssh") {
        if (args.includes("check")) return "";
        if (!remoteOk) throw new Error("remote curl failed");
        assert.equal(args.at(-1), "curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18080/health/live");
        return '{"status":"ok"}';
      }
      const action = args[0] === "--user" ? args[1] : args[0];
      const target = args.find(value => /life\.offerpilot\.axiom-(api|tunnel)-/.test(value)) ?? "";
      const key = target.includes("axiom-tunnel-") ? "tunnel" : "api";
      const state = states.get(key) ?? { running: false, enabled: false };
      states.set(key, state);
      if (["kickstart", "start", "restart"].includes(action)) state.running = true;
      if (action === "bootout") state.running = false;
      if (action === "enable") state.enabled = true;
      if (action === "disable") { state.enabled = false; if (args.includes("--now")) state.running = false; }
      if (action === "print") return `state = ${state.running ? "running" : "waiting"}`;
      if (action === "show") return `ActiveState=${state.running ? "active" : "inactive"}\nUnitFileState=${state.enabled ? "enabled" : "disabled"}`;
      return "";
    } };
    try {
      const manager = createSshTunnelManager(deps);
      await saveServiceExposure({ publicBaseUrl: "", connectionMode: "ssh", upstreamUrl: "http://malicious.test", capabilities: ["images"] });
      assert.equal((await loadServiceExposure()).upstreamUrl, "http://127.0.0.1:18080");
      await createServiceCredential("test", ["images"]);
      const identityFile = path.join(root, "key with spaces");
      await fs.writeFile(identityFile, "test fixture, not a key", { mode: 0o600 });
      await manager.save({ ...config, identityFile });
      assert.equal((await loadSshTunnel()).host, config.host);
      assert.equal((await fs.stat(path.join(root, "ssh-tunnel.json"))).mode & 0o777, 0o600);
      await assert.rejects(manager.control("start"), /先启动/);
      await createApiServiceManager(deps).control("start");
      assert.equal((await manager.control("start")).connected, true);
      await assert.rejects(manager.save({ ...config, identityFile }), /先停止/);
      assert.equal((await manager.test()).ok, true);
      remoteOk = false;
      await assert.rejects(manager.test(), /端口验证失败/);
      const auto = await manager.control("enable");
      assert.equal(auto.autostart, true);
      const stop = await manager.control("stop");
      assert.equal(stop.running, false);
      assert.equal(stop.autostart, false);
      assert.equal((await createApiServiceManager(deps).status()).running, true);
      await assert.rejects(manager.test(), /尚未连接/);
      await manager.save({ ...config, identityFile: path.join(root, "missing") });
      await assert.rejects(manager.control("start"), /私钥文件不存在/);
      await assert.rejects(manager.control("bad action"), /未知/);
      assert.ok(calls.some(([command]) => command === "ssh"));
      await saveServiceExposure({ publicBaseUrl: "", connectionMode: "local", capabilities: ["images"] });
      assert.equal((await loadServiceExposure()).upstreamUrl, "http://127.0.0.1:8080");
      await assert.rejects(manager.control("start"), /接入模式/);
    } finally {
      if (previous === undefined) delete process.env.AI_GATEWAY_HOME; else process.env.AI_GATEWAY_HOME = previous;
      await fs.rm(root, { force: true, recursive: true });
    }
  });
}

test("local API health check never probes the remote server loopback upstream", async () => {
  const previous = process.env.AI_GATEWAY_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-local-health-"));
  process.env.AI_GATEWAY_HOME = root;
  let probed = false;
  const remote = http.createServer((req, res) => { probed = true; res.end('{"status":"ok"}'); });
  await new Promise(resolve => remote.listen(0, "127.0.0.1", resolve));
  try {
    await saveServiceExposure({ publicBaseUrl: "", upstreamUrl: `http://127.0.0.1:${remote.address().port}`, capabilities: [] });
    await checkServiceConnection("upstream");
    assert.equal(probed, false);
    await assert.rejects(saveServiceExposure({ publicBaseUrl: "", connectionMode: "bad", capabilities: [] }), /同机/);
  } finally {
    await new Promise(resolve => remote.close(resolve));
    if (previous === undefined) delete process.env.AI_GATEWAY_HOME; else process.env.AI_GATEWAY_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
