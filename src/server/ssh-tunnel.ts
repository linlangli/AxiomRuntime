import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { loadSshTunnel, managedTunnelArgs, tunnelSocket, validateSshTunnel } from "../core/services/ssh-tunnel.js";

const config = validateSshTunnel(await loadSshTunnel());
const child = spawn("ssh", managedTunnelArgs(config), { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" } });
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { stopping = true; child.kill("SIGTERM"); });
child.on("error", () => { console.error("SSH could not start. Ensure OpenSSH is installed and available in the service PATH."); process.exitCode = 1; });
child.on("close", async () => {
  await fs.rm(tunnelSocket(), { force: true }).catch(() => undefined);
  process.exitCode = stopping ? 0 : 1;
});
