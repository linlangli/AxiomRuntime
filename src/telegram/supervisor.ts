#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listBots, migrateLegacyConfig } from "./bot-registry.js";

const entry = fileURLToPath(new URL("./index.js", import.meta.url));
const children = new Set<ChildProcess>();
let stopping = false;

await migrateLegacyConfig();
const configuredBots = listBots();
const botNames: Array<string | null> = configuredBots.length
  ? configuredBots.map((bot) => bot.name)
  : [null];

for (const botName of botNames) {
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: {
      ...process.env,
      AI_GATEWAY_SOURCE: "telegram-service",
      ...(botName ? { AI_TELEGRAM_BOT_NAME: botName } : {})
    }
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(`Telegram bot ${botName ?? "default"} failed to start: ${error.message}`);
    if (!stopping) void stopChildren("SIGTERM", 1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`Telegram bot ${botName ?? "default"} exited (${signal ?? code ?? "unknown"}).`);
      void stopChildren("SIGTERM", code && code > 0 ? code : 1);
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void stopChildren(signal === "SIGHUP" ? "SIGTERM" : signal, 0);
  });
}

console.log(`Telegram service supervising ${botNames.length} bot(s): ${botNames.map((name) => name ?? "default").join(", ")}`);
await new Promise<void>(() => undefined);

async function stopChildren(signal: NodeJS.Signals, exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  const pending = [...children].map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill(signal);
  }));
  await Promise.all(pending);
  process.exit(exitCode);
}
