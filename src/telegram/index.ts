#!/usr/bin/env node
import fs from "node:fs/promises";
import { getTelegramPidPath } from "../core/config/paths.js";
import { createBot } from "./bot.js";
import { writeTelegramLog } from "./log.js";

async function main(): Promise<void> {
  const runtime = await createBot();
  await fs.writeFile(getTelegramPidPath(), `${process.pid}\n`, "utf8");
  await writeTelegramLog({
    action: "bot_start",
    message: `Telegram bot started with PID ${process.pid}`,
    metadata: {
      allowedUsers: runtime.config.allowedUserIds.length,
      defaultEngine: runtime.config.defaultEngine
    }
  });

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    await writeTelegramLog({ action: "bot_stop", message: `Telegram bot stopping after ${signal}` });
    runtime.engines.claude.abort(Number.NaN);
    runtime.engines.codex.abort(Number.NaN);
    await runtime.bot.stop();
    runtime.store.close();
    try {
      await fs.unlink(getTelegramPidPath());
    } catch {
      // PID file may already be removed by CLI stop.
    }
  };

  process.once("SIGTERM", () => {
    void stop("SIGTERM").finally(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void stop("SIGINT").finally(() => process.exit(0));
  });

  await runtime.bot.start({
    drop_pending_updates: false,
    onStart: (botInfo) => {
      void writeTelegramLog({
        action: "polling_started",
        message: `Telegram polling started as @${botInfo.username}`,
        metadata: { username: botInfo.username }
      });
    }
  });
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  await writeTelegramLog({ level: "error", action: "bot_fatal", message });
  try {
    await fs.unlink(getTelegramPidPath());
  } catch {
    // Ignore cleanup failures during fatal startup errors.
  }
  console.error(message);
  process.exitCode = 1;
});
