import { execFile, fork } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigRoot, getTelegramBotConfigPath, getTelegramBotPidPath } from "../config/paths.js";
import { loadBotConfig } from "../config/telegram-config.js";
import { withJsonFileLock } from "../config/json-store.js";
import { SettingsInputError } from "../config/service-exposure.js";
import { isBotRunning, isValidBotName, markLegacyMigrationComplete } from "../../telegram/bot-registry.js";
import { writeLog } from "../logs/log-service.js";

const execute = promisify(execFile);
function ownershipArgument(name: string) {
  return `--axiom-bot-${crypto.createHash("sha256").update(`${getConfigRoot()}\0${name}`).digest("hex")}`;
}

async function verifyBotProcess(name: string, pid: number) {
  try {
    const command = process.platform === "win32"
      ? (await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { timeout: 5000, maxBuffer: 65536 })).stdout
      : (await execute("ps", ["-p", String(pid), "-o", "args="], { timeout: 5000, maxBuffer: 65536 })).stdout;
    if (command.includes(ownershipArgument(name)) && /[\\/]telegram[\\/]index\.js/.test(command)) return;
  } catch {}
  throw new SettingsInputError("无法确认 PID 属于此 Bot，拒绝发送信号。旧版 Bot 请先核实进程并手动停止，再从新版启动。");
}

export async function controlBot(name: unknown, action: unknown) {
  if (typeof name !== "string" || !isValidBotName(name)) throw new SettingsInputError("Bot 名称无效。");
  if (!["start", "stop", "restart", "delete", "status"].includes(String(action))) throw new SettingsInputError("Bot 操作无效。");
  return withJsonFileLock(`${getTelegramBotConfigPath(name)}.control`, async () => {
    await fs.access(getTelegramBotConfigPath(name)).catch(() => { throw new SettingsInputError("Bot 配置不存在。"); });
    const config = await loadBotConfig(name);
    if (["stop", "restart", "delete"].includes(String(action))) {
      const state = isBotRunning(name);
      if (state.running && state.pid) {
        await verifyBotProcess(name, state.pid);
        process.kill(state.pid, "SIGTERM");
        const deadline = Date.now() + 5_000;
        while (isBotRunning(name).running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        if (isBotRunning(name).running) throw new SettingsInputError("Bot 未能停止，配置与数据已保留。");
      }
      await fs.rm(getTelegramBotPidPath(name), { force: true });
    }
    if (action === "delete") {
      if (name === "default") await markLegacyMigrationComplete();
      await fs.rm(getTelegramBotConfigPath(name));
    }
    if (action === "start" || action === "restart") {
      if (!config.token || !config.allowedUserIds.length && !config.allowAllUsers) throw new SettingsInputError("请先配置 Token 和用户白名单。");
      if (!isBotRunning(name).running) {
        const child = fork(fileURLToPath(new URL("../../telegram/index.js", import.meta.url)), [ownershipArgument(name)], { detached: true, stdio: "ignore", env: { ...process.env, AI_TELEGRAM_BOT_NAME: name, AI_GATEWAY_SOURCE: "telegram" } });
        child.on("error", () => undefined);
        child.unref();
        if (child.connected) child.disconnect();
        if (!child.pid) throw new SettingsInputError("Bot 启动失败。");
        await fs.mkdir(path.dirname(getTelegramBotPidPath(name)), { recursive: true });
        await fs.writeFile(getTelegramBotPidPath(name), String(child.pid), { mode: 0o600 });
      }
    }
    await writeLog({ category: "provider", action: "web_bot_control", message: `Bot ${String(action)}.`, metadata: { bot: name } });
    return { ...isBotRunning(name), effect: action === "delete" ? "Bot 配置已删除，会话数据库与日志保留。" : "操作完成；进程状态不代表 Telegram 网络已连通。" };
  });
}
