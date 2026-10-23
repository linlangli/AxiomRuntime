import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiServiceManager, renderApiService } from "../dist/core/services/api-service.js";
import { saveServiceExposure, createServiceCredential } from "../dist/core/config/service-exposure.js";

for (const platform of ["darwin", "linux"]) {
  test(`${platform} API service lifecycle uses user manager, survives disabling autostart and stops idempotently`, async () => {
    const previous = process.env.AI_GATEWAY_HOME;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-service-"));
    process.env.AI_GATEWAY_HOME = path.join(root, "runtime & spaces");
    const calls = [];
    let running = false;
    let loaded = false;
    let enabled = false;
    const manager = createApiServiceManager({ platform, home: root, run: async (command, args) => {
      calls.push([command, args]);
      const action = args[0] === "--user" ? args[1] : args[0];
      if (action === "bootstrap") loaded = true;
      if (action === "bootout") { if (!loaded) throw new Error("not loaded"); loaded = false; running = false; }
      if (["kickstart", "start", "restart"].includes(action)) running = true;
      if (action === "enable") enabled = true;
      if (action === "disable") { enabled = false; if (args.includes("--now")) running = false; }
      if (action === "print") { if (!loaded) throw new Error("not loaded"); return `state = ${running ? "running" : "waiting"}`; }
      if (action === "show") return `ActiveState=${running ? "active" : "inactive"}\nUnitFileState=${enabled ? "enabled" : "disabled"}`;
      return "";
    } });
    try {
      assert.equal((await manager.status()).installed, false);
      await assert.rejects(manager.control("start"), /凭证/);
      assert.equal(calls.length, 0);
      await saveServiceExposure({ publicBaseUrl: "", upstreamUrl: "http://127.0.0.1:8080", capabilities: ["images"] });
      await createServiceCredential("test", ["images"]);
      assert.equal((await manager.control("start")).running, true);
      assert.equal((await manager.status()).autostart, false);
      const files = await fs.readdir(platform === "darwin" ? path.join(root, "Library/LaunchAgents") : path.join(root, ".config/systemd/user"));
      const file = path.join(platform === "darwin" ? path.join(root, "Library/LaunchAgents") : path.join(root, ".config/systemd/user"), files[0]);
      const source = await fs.readFile(file, "utf8");
      assert.match(source, /server\/index\.js/);
      assert.match(source, /AXIOM_MANAGED_API/);
      assert.doesNotMatch(source, /axm_|TOKEN|npm run/);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      const auto = await manager.control("enable");
      assert.equal(auto.running, true); assert.equal(auto.autostart, true);
      const disabled = await manager.control("disable");
      assert.equal(disabled.running, true); assert.equal(disabled.autostart, false);
      assert.equal((await manager.control("restart")).running, true);
      assert.equal((await manager.control("stop")).running, false);
      assert.equal((await manager.control("stop")).autostart, false);
      await assert.rejects(manager.control("unknown"), /未知/);
    } finally {
      if (previous === undefined) delete process.env.AI_GATEWAY_HOME;
      else process.env.AI_GATEWAY_HOME = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("service descriptors escape paths and reject multiline injection", () => {
  const input = { label: "test", node: '/node path/"node', entry: "/app/server.js", root: "/tmp/a&b%$", log: "/tmp/log", autostart: false };
  assert.match(renderApiService("darwin", input), /a&amp;b/);
  assert.match(renderApiService("linux", input), /a&b%%\$/);
  assert.throws(() => renderApiService("linux", { ...input, root: "/tmp\nExecStart=bad" }), /Invalid/);
});

test("unsupported service platforms report limitations and reject mutation", async () => {
  const manager = createApiServiceManager({ platform: "freebsd", run: async () => { throw new Error("must not execute"); } });
  assert.equal((await manager.status()).supported, false);
  await assert.rejects(manager.control("start"), /不支持/);
});
