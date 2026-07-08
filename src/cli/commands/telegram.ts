import { fork } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTelegramConfigPath, getTelegramLogPath, getTelegramPidPath } from "../../core/config/paths.js";
import {
  describeTelegramConfig,
  loadTelegramConfig,
  saveTelegramConfig,
  setTelegramConfigValue,
  type TelegramConfig,
  type TelegramEngineName,
  type TelegramPermissionMode
} from "../../telegram/config.js";
import { ensureTelegramLogFile, readRecentTelegramLogLines } from "../../telegram/log.js";
import { checkTelegramApi, getTelegramProxyUrl } from "../../telegram/network.js";
import { promptSelect, promptText } from "../prompts/prompt.js";

type TelegramSubcommand = "start" | "stop" | "status" | "config" | "logs" | "doctor";

export async function runTelegramCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand as TelegramSubcommand | undefined) {
    case undefined:
      await runTelegramInteractive();
      return;
    case "start":
      await startTelegramBot();
      return;
    case "stop":
      await stopTelegramBot();
      return;
    case "status":
      await showTelegramStatus();
      return;
    case "config":
      await runTelegramConfigCommand(rest);
      return;
    case "logs":
      await showTelegramLogs(rest);
      return;
    case "doctor":
      await runTelegramDoctor();
      return;
    default:
      throw new Error(`Unknown telegram command: ${subcommand}`);
  }
}

async function runTelegramInteractive(): Promise<void> {
  const command = await promptSelect("Telegram", [
    { label: "start", value: "start" },
    { label: "stop", value: "stop" },
    { label: "status", value: "status" },
    { label: "config", value: "config" },
    { label: "logs", value: "logs" },
    { label: "doctor", value: "doctor" },
    { label: "exit", value: "exit" }
  ]);
  if (command === "start") await startTelegramBot();
  if (command === "stop") await stopTelegramBot();
  if (command === "status") await showTelegramStatus();
  if (command === "config") await runTelegramConfigCommand([]);
  if (command === "logs") await showTelegramLogs([]);
  if (command === "doctor") await runTelegramDoctor();
}

async function startTelegramBot(): Promise<void> {
  const config = await loadTelegramConfig();
  if (!config.token) {
    throw new Error("Telegram token is not configured. Run `ai telegram config set token <token>`.");
  }
  if (!config.allowAllUsers && !config.allowedUserIds.length) {
    throw new Error("No Telegram users are allowed. Run `ai telegram config set allowedUserIds <id>` or `ai telegram config set allowAllUsers true`.");
  }

  const existingPid = await readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Telegram bot is already running (PID: ${existingPid}).`);
    return;
  }
  if (existingPid) await removePid();

  const logPath = await ensureTelegramLogFile();
  const entry = resolveTelegramEntryPath();
  const child = fork(entry, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AI_GATEWAY_SOURCE: "telegram-cli"
    }
  });
  child.unref();
  if (child.connected) {
    child.disconnect();
  }
  if (!child.pid) {
    throw new Error("Failed to start Telegram bot process.");
  }
  await writePid(child.pid);
  console.log(`Telegram bot started (PID: ${child.pid}).`);
  console.log(`Log: ${logPath}`);
}

async function stopTelegramBot(): Promise<void> {
  const pid = await readPid();
  if (!pid) {
    console.log("Telegram bot is not running.");
    return;
  }
  if (!isProcessRunning(pid)) {
    await removePid();
    console.log("Telegram bot was not running; stale PID file removed.");
    return;
  }

  process.kill(pid, "SIGTERM");
  await waitForStop(pid, 5000);
  await removePid();
  console.log("Telegram bot stopped.");
}

async function showTelegramStatus(): Promise<void> {
  const pid = await readPid();
  const config = await loadTelegramConfig();
  const running = Boolean(pid && isProcessRunning(pid));
  console.log(`Telegram Bot: ${running ? "running" : "stopped"}`);
  if (pid) console.log(`PID: ${pid}${running ? "" : " (stale)"}`);
  console.log(`Config: ${getTelegramConfigPath()}`);
  console.log(`Log: ${getTelegramLogPath()}`);
  console.log(`Token: ${config.token ? "configured" : "missing"}`);
  console.log(`Allow all users: ${config.allowAllUsers ? "yes" : "no"}`);
  console.log(`Allowed users: ${config.allowedUserIds.length ? config.allowedUserIds.join(", ") : "(empty)"}`);
  console.log(`Proxy: ${getTelegramProxyUrl(config) ?? "(none)"}`);
  console.log(`Default: ${config.defaultEngine} / ${config.defaultPermissionMode} / ${config.defaultCwd}`);
}

async function runTelegramConfigCommand(args: string[]): Promise<void> {
  const [action, key, ...valueParts] = args;
  if (action === "set") {
    if (!key || !valueParts.length) {
      throw new Error("Usage: ai telegram config set <key> <value>");
    }
    const config = await setTelegramConfigValue(key, valueParts.join(" "));
    console.log(`Updated telegram config: ${key}`);
    printTelegramConfig(config);
    return;
  }
  if (action === "show") {
    printTelegramConfig(await loadTelegramConfig());
    return;
  }
  if (action) {
    throw new Error(`Unknown telegram config command: ${action}`);
  }
  await editTelegramConfigInteractive();
}

async function editTelegramConfigInteractive(): Promise<void> {
  let config = await loadTelegramConfig();
  while (true) {
    console.log("");
    printTelegramConfig(config);
    const field = await promptSelect("Edit Telegram config", [
      { label: "token", value: "token" },
      { label: "allowAllUsers", value: "allowAllUsers" },
      { label: "allowedUserIds", value: "allowedUserIds" },
      { label: "defaultEngine", value: "defaultEngine" },
      { label: "defaultCwd", value: "defaultCwd" },
      { label: "defaultPermissionMode", value: "defaultPermissionMode" },
      { label: "sessionTimeoutHours", value: "sessionTimeoutHours" },
      { label: "maxOutputLength", value: "maxOutputLength" },
      { label: "provider", value: "provider" },
      { label: "model", value: "model" },
      { label: "proxyUrl", value: "proxyUrl" },
      { label: "done", value: "done" }
    ]);
    if (field === "done") return;
    if (field === "defaultEngine") {
      const defaultEngine = await promptSelect<TelegramEngineName>("Default engine", [
        { label: "claude", value: "claude" },
        { label: "codex", value: "codex" }
      ]);
      config = await saveTelegramConfig({ ...config, defaultEngine });
      continue;
    }
    if (field === "defaultPermissionMode") {
      const defaultPermissionMode = await promptSelect<TelegramPermissionMode>("Default permission mode", [
        { label: "bypassPermissions", value: "bypassPermissions" },
        { label: "acceptEdits", value: "acceptEdits" },
        { label: "default", value: "default" }
      ]);
      config = await saveTelegramConfig({ ...config, defaultPermissionMode });
      continue;
    }
    const current = String(config[field as keyof TelegramConfig] ?? "");
    const value = await promptText(field, { defaultValue: current });
    config = await setTelegramConfigValue(field, value);
  }
}

async function runTelegramDoctor(): Promise<void> {
  const config = await loadTelegramConfig();
  if (!config.token) {
    throw new Error("Telegram token is not configured.");
  }
  const proxyUrl = getTelegramProxyUrl(config);
  console.log(`Telegram API: checking getMe${proxyUrl ? ` via ${proxyUrl}` : ""}...`);
  const result = await checkTelegramApi(config.token, proxyUrl ?? undefined);
  if (result.ok) {
    console.log(`Telegram API: ok${result.username ? ` (@${result.username})` : ""}`);
    return;
  }
  console.log(`Telegram API: failed${result.status ? ` (HTTP ${result.status})` : ""}`);
  console.log(result.error ?? "Unknown error");
  console.log("If your network blocks api.telegram.org, run:");
  console.log("ai telegram config set proxyUrl http://127.0.0.1:7890");
}

async function showTelegramLogs(args: string[]): Promise<void> {
  const follow = args.includes("-f") || args.includes("--follow");
  const limitArg = args.find((arg) => /^\d+$/.test(arg));
  const limit = limitArg ? Number(limitArg) : 50;
  const filePath = await ensureTelegramLogFile();
  const lines = await readRecentTelegramLogLines(limit);
  if (!lines.length) {
    console.log(`No Telegram logs yet: ${filePath}`);
  } else {
    for (const line of lines) console.log(formatLogLine(line));
  }
  if (follow) {
    await followLogFile(filePath);
  }
}

function printTelegramConfig(config: TelegramConfig): void {
  console.log(`Telegram config: ${getTelegramConfigPath()}`);
  for (const line of describeTelegramConfig(config)) {
    console.log(line);
  }
}

async function readPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(getTelegramPidPath(), "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePid(pid: number): Promise<void> {
  await fs.mkdir(path.dirname(getTelegramPidPath()), { recursive: true });
  await fs.writeFile(getTelegramPidPath(), `${pid}\n`, "utf8");
}

async function removePid(): Promise<void> {
  try {
    await fs.unlink(getTelegramPidPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForStop(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function resolveTelegramEntryPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../../telegram/index.js");
}

function formatLogLine(line: string): string {
  try {
    const event = JSON.parse(line) as { timestamp?: string; level?: string; action?: string; message?: string };
    return `[${event.timestamp ?? ""}] ${event.level ?? "info"} ${event.action ?? ""}: ${event.message ?? ""}`;
  } catch {
    return line;
  }
}

async function followLogFile(filePath: string): Promise<void> {
  console.log(`Following ${filePath}. Press Ctrl+C to stop.`);
  const { spawn } = await import("node:child_process");
  const child = spawn("tail", ["-f", filePath], { stdio: "inherit" });
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}
