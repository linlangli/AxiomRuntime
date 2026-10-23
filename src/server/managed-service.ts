import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.argv[2];
const kind = process.argv[3];
if (!root || !path.isAbsolute(root) || kind !== "api" && kind !== "tunnel") throw new Error("Invalid managed service arguments.");
process.env.AI_GATEWAY_HOME = root;
process.env.AXIOM_MANAGED_API = "1";
const log = fs.openSync(path.join(root, `${kind}-service.log`), "a", 0o600);
const entry = fileURLToPath(new URL(kind === "api" ? "./index.js" : "./ssh-tunnel.js", import.meta.url));
const child = spawn(process.execPath, [entry], { stdio: ["ignore", log, log], env: process.env, windowsHide: true });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
child.on("error", () => { process.exitCode = 1; });
child.on("close", code => { fs.closeSync(log); process.exitCode = code ?? 1; });
