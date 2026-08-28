import { fork } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTelegramBotConfigPath,
  getTelegramBotLogPath,
  getTelegramBotPidPath,
  getTelegramConfigPath,
  getTelegramLogPath,
  getTelegramPidPath
} from "../../core/config/paths.js";
import {
  describeTelegramConfig,
  loadBotConfig,
  loadTelegramConfig,
  saveBotConfig,
  saveTelegramConfig,
  setBotConfigValue,
  setTelegramConfigValue,
  type TelegramConfig,
  type TelegramEngineName,
  type TelegramPermissionMode
} from "../../telegram/config.js";
import {
  botExists,
  isBotRunning,
  isValidBotName,
  listBots,
  migrateLegacyConfig,
  removeBotFiles
} from "../../telegram/bot-registry.js";
import { ensureTelegramLogFile, readRecentTelegramLogLines } from "../../telegram/log.js";
import { checkTelegramApi, getTelegramProxyUrl } from "../../telegram/network.js";
import { promptConfirm, promptSelect, promptText } from "../prompts/prompt.js";

type TelegramSubcommand = "start" | "stop" | "status" | "config" | "logs" | "doctor"
  | "add" | "edit" | "remove" | "delete" | "list";

export type TelegramTargetArgs = {
  args: string[];
  botName?: string;
  all: boolean;
};

export const TELEGRAM_PROXY_URL_PROMPT = "Proxy URL (include protocol, e.g. http://127.0.0.1:7890)";

export async function runTelegramCommand(args: string[]): Promise<void> {
  const target = parseTelegramTargetArgs(args);
  const [subcommand, ...rest] = target.args;
  switch (subcommand as TelegramSubcommand | undefined) {
    case undefined:
      await runTelegramInteractive(target.botName, target.all);
      return;
    case "add":
      assertNotAll(target, "add");
      await addBot(resolveBotName(target.botName, rest[0], "add"));
      return;
    case "edit":
      assertNotAll(target, "edit");
      await editNamedBot(resolveBotName(target.botName, rest[0], "edit") ?? await selectNamedBot("Edit bot"));
      return;
    case "delete":
    case "remove":
      assertNotAll(target, subcommand);
      {
        const explicitName = resolveBotName(target.botName, rest[0], subcommand);
        const name = explicitName ?? await selectNamedBot(`${subcommand === "delete" ? "Delete" : "Remove"} bot`);
        if (!explicitName && !await promptConfirm(`Delete bot "${name}" and its config, PID, log, and session database?`)) {
          console.log("Delete cancelled.");
          return;
        }
        await removeBot(name);
      }
      return;
    case "list":
      assertUntargeted(target, "list");
      await listAllBots();
      return;
    case "start":
      await startTelegramBot(resolveLifecycleTarget(target, rest[0], "start"));
      return;
    case "stop":
      await stopTelegramBot(resolveLifecycleTarget(target, rest[0], "stop"));
      return;
    case "status":
      await showTelegramStatus(resolveLifecycleTarget(target, rest[0], "status"));
      return;
    case "config":
      assertNotAll(target, "config");
      await runTelegramConfigCommand(rest, target.botName);
      return;
    case "logs":
      assertNotAll(target, "logs");
      await showTelegramLogs(rest, target.botName);
      return;
    case "doctor":
      assertNotAll(target, "doctor");
      await runTelegramDoctor(resolveBotName(target.botName, rest[0], "doctor"));
      return;
    default:
      throw new Error(`Unknown telegram command: ${subcommand}`);
  }
}

export function parseTelegramTargetArgs(args: string[]): TelegramTargetArgs {
  const remaining: string[] = [];
  let botName: string | undefined;
  let all = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--bot") {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) throw new Error("Usage: --bot <name>");
      if (botName && botName !== value) throw new Error(`Conflicting bot targets: "${botName}" and "${value}".`);
      botName = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--bot=")) {
      const value = arg.slice("--bot=".length).trim();
      if (!value) throw new Error("Usage: --bot=<name>");
      if (botName && botName !== value) throw new Error(`Conflicting bot targets: "${botName}" and "${value}".`);
      botName = value;
      continue;
    }
    remaining.push(arg);
  }

  if (botName && !isValidBotName(botName)) {
    throw new Error(`Invalid bot name: "${botName}". Use lowercase letters, digits, hyphens, underscores (max 32 chars).`);
  }
  if (botName && all) throw new Error("Use either --bot <name> or --all, not both.");
  return { args: remaining, ...(botName ? { botName } : {}), all };
}

async function runTelegramInteractive(botName?: string, all = false): Promise<void> {
  const choices: Array<{ label: string; value: string }> = [
    ...(!botName && !all ? [{ label: "add", value: "add" }] : []),
    { label: "list", value: "list" },
    ...(!all ? [
      { label: "edit", value: "edit" },
      { label: "delete", value: "delete" }
    ] : []),
    { label: "start", value: "start" },
    { label: "stop", value: "stop" },
    { label: "status", value: "status" },
    ...(!all ? [
      { label: "config", value: "config" },
      { label: "logs", value: "logs" },
      { label: "doctor", value: "doctor" }
    ] : []),
    { label: "exit", value: "exit" }
  ];
  const command = await promptSelect("Telegram", choices);
  if (command === "add") { assertNotAll({ all }, "add"); await addBot(botName); }
  if (command === "list") await listAllBots();
  if (command === "edit") {
    assertNotAll({ all }, "edit");
    await editNamedBot(botName ?? await selectNamedBot("Edit bot"));
  }
  if (command === "delete") {
    assertNotAll({ all }, "delete");
    const name = botName ?? await selectNamedBot("Delete bot");
    const confirmed = await promptConfirm(`Delete bot "${name}" and its config, PID, log, and session database?`);
    if (confirmed) await removeBot(name);
    else console.log("Delete cancelled.");
  }
  if (command === "start") await startTelegramBot(await selectLifecycleBot("Start bot", botName, all));
  if (command === "stop") await stopTelegramBot(await selectLifecycleBot("Stop bot", botName, all));
  if (command === "status") await showTelegramStatus(await selectLifecycleBot("Show bot status", botName, all));
  if (command === "config") {
    assertNotAll({ all }, "config");
    await runTelegramConfigCommand([], botName ?? await selectOptionalBot("Edit config"));
  }
  if (command === "logs") {
    assertNotAll({ all }, "logs");
    await showTelegramLogs([], botName ?? await selectOptionalBot("Show logs"));
  }
  if (command === "doctor") {
    assertNotAll({ all }, "doctor");
    await runTelegramDoctor(botName ?? await selectOptionalBot("Diagnose bot"));
  }
}

async function selectNamedBot(message: string): Promise<string> {
  await migrateLegacyConfig();
  const bots = listBots();
  if (!bots.length) throw new Error("No bots configured. Add one with: ai telegram add <name>");
  return promptSelect(message, bots.map((bot) => ({ label: bot.name, value: bot.name })));
}

async function selectOptionalBot(message: string): Promise<string | undefined> {
  await migrateLegacyConfig();
  const bots = listBots();
  if (!bots.length) return undefined;
  return promptSelect(message, bots.map((bot) => ({ label: bot.name, value: bot.name })));
}

async function selectLifecycleBot(message: string, botName?: string, all = false): Promise<string | undefined> {
  if (botName) return botName;
  if (all) return undefined;
  await migrateLegacyConfig();
  const bots = listBots();
  if (!bots.length) return undefined;
  const allTarget = "__all__";
  const selected = await promptSelect(message, [
    ...bots.map((bot) => ({ label: bot.name, value: bot.name })),
    { label: "all bots", value: allTarget }
  ]);
  return selected === allTarget ? undefined : selected;
}

async function addBot(nameArg?: string): Promise<void> {
  const name = nameArg?.trim() || await promptText("Bot name (lowercase, a-z0-9_-)");
  if (!isValidBotName(name)) {
    throw new Error(`Invalid bot name: "${name}". Use lowercase letters, digits, hyphens, underscores (max 32 chars).`);
  }
  if (botExists(name)) {
    throw new Error(`Bot "${name}" already exists. Use \`ai telegram config ${name}\` to edit.`);
  }
  const token = await promptText("Telegram bot token");
  if (!token.trim()) throw new Error("Token is required.");
  const allowedUserIds = await promptText("Allowed user IDs (comma-separated, empty for allowAll)");
  const proxyUrl = await promptText(`${TELEGRAM_PROXY_URL_PROMPT} (empty to skip)`, { defaultValue: "" });

  const config: Partial<TelegramConfig> = {
    token: token.trim(),
    ...(proxyUrl.trim() ? { proxyUrl: proxyUrl.trim() } : {})
  };
  if (allowedUserIds.trim()) {
    config.allowedUserIds = allowedUserIds.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } else {
    config.allowAllUsers = true;
  }
  await saveBotConfig(name, config as TelegramConfig);
  console.log(`Bot "${name}" added. Start with: ai telegram start ${name}`);
}

async function removeBot(name: string): Promise<void> {
  if (!botExists(name)) throw new Error(`Bot "${name}" does not exist.`);
  const config = await loadBotConfig(name);
  const { running, pid } = isBotRunning(name);
  if (running && pid) {
    process.kill(pid, "SIGTERM");
    if (!await waitForStop(pid, 5000)) {
      throw new Error(`Bot "${name}" did not stop within 5 seconds; its files were kept.`);
    }
    console.log(`Stopped bot "${name}".`);
  }
  await removeBotFiles(name, config.dbPath);
  console.log(`Bot "${name}" removed.`);
}

async function listAllBots(): Promise<void> {
  await migrateLegacyConfig();
  const bots = listBots();
  if (!bots.length) {
    console.log("No bots configured. Add one with: ai telegram add <name>");
    return;
  }
  console.log(`Configured bots (${bots.length}):\n`);
  for (const bot of bots) {
    const { running, pid } = isBotRunning(bot.name);
    const status = running ? `running (PID: ${pid})` : "stopped";
    console.log(`  ${bot.name} — ${status}`);
  }
}

async function startTelegramBot(nameArg?: string): Promise<void> {
  await migrateLegacyConfig();
  if (!nameArg) {
    const bots = listBots();
    if (!bots.length) {
      await startLegacyBot();
      return;
    }
    let started = 0;
    for (const bot of bots) {
      await startNamedBot(bot.name);
      started++;
    }
    console.log(`Started ${started} bot(s).`);
    return;
  }
  await startNamedBot(nameArg);
}

async function startNamedBot(name: string): Promise<void> {
  if (!botExists(name)) throw new Error(`Bot "${name}" does not exist.`);
  const config = await loadBotConfig(name);
  if (!config.token) {
    throw new Error(`Bot "${name}": token is not configured.`);
  }
  if (!config.allowAllUsers && !config.allowedUserIds.length) {
    throw new Error(`Bot "${name}": no users allowed.`);
  }
  const { running, pid: existingPid } = isBotRunning(name);
  if (running) {
    console.log(`Bot "${name}" is already running (PID: ${existingPid}).`);
    return;
  }
  if (existingPid) await removePidFile(getTelegramBotPidPath(name));

  const logPath = getTelegramBotLogPath(name);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const entry = resolveTelegramEntryPath();
  const child = fork(entry, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AI_TELEGRAM_BOT_NAME: name, AI_GATEWAY_SOURCE: "telegram-cli" }
  });
  child.unref();
  if (child.connected) child.disconnect();
  if (!child.pid) throw new Error(`Failed to start bot "${name}".`);
  await writePidFile(getTelegramBotPidPath(name), child.pid);
  console.log(`Bot "${name}" started (PID: ${child.pid}).`);
}

async function startLegacyBot(): Promise<void> {
  const config = await loadTelegramConfig();
  if (!config.token) {
    throw new Error("Telegram token is not configured. Run `ai telegram config set token <token>`.");
  }
  if (!config.allowAllUsers && !config.allowedUserIds.length) {
    throw new Error("No Telegram users are allowed.");
  }
  const existingPid = await readPid(getTelegramPidPath());
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Telegram bot is already running (PID: ${existingPid}).`);
    return;
  }
  if (existingPid) await removePidFile(getTelegramPidPath());

  const logPath = await ensureTelegramLogFile();
  const entry = resolveTelegramEntryPath();
  const child = fork(entry, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AI_GATEWAY_SOURCE: "telegram-cli" }
  });
  child.unref();
  if (child.connected) child.disconnect();
  if (!child.pid) throw new Error("Failed to start Telegram bot process.");
  await writePidFile(getTelegramPidPath(), child.pid);
  console.log(`Telegram bot started (PID: ${child.pid}).`);
  console.log(`Log: ${logPath}`);
}

async function stopTelegramBot(nameArg?: string): Promise<void> {
  await migrateLegacyConfig();
  if (!nameArg) {
    const bots = listBots();
    if (!bots.length) {
      await stopLegacyBot();
      return;
    }
    let stopped = 0;
    for (const bot of bots) {
      if (await stopNamedBot(bot.name)) stopped++;
    }
    console.log(`Stopped ${stopped} bot(s).`);
    return;
  }
  await stopNamedBot(nameArg);
}

async function stopNamedBot(name: string): Promise<boolean> {
  if (!botExists(name)) throw new Error(`Bot "${name}" does not exist.${availableBotsHint()}`);
  const { running, pid } = isBotRunning(name);
  if (!running) {
    if (pid) await removePidFile(getTelegramBotPidPath(name));
    console.log(`Bot "${name}" is not running.`);
    return false;
  }
  process.kill(pid!, "SIGTERM");
  if (!await waitForStop(pid!, 5000)) {
    throw new Error(`Bot "${name}" did not stop within 5 seconds; its PID file was kept.`);
  }
  await removePidFile(getTelegramBotPidPath(name));
  console.log(`Bot "${name}" stopped.`);
  return true;
}

async function stopLegacyBot(): Promise<void> {
  const pid = await readPid(getTelegramPidPath());
  if (!pid) { console.log("Telegram bot is not running."); return; }
  if (!isProcessRunning(pid)) {
    await removePidFile(getTelegramPidPath());
    console.log("Telegram bot was not running; stale PID file removed.");
    return;
  }
  process.kill(pid, "SIGTERM");
  if (!await waitForStop(pid, 5000)) {
    throw new Error("Telegram bot did not stop within 5 seconds; its PID file was kept.");
  }
  await removePidFile(getTelegramPidPath());
  console.log("Telegram bot stopped.");
}

async function showTelegramStatus(nameArg?: string): Promise<void> {
  await migrateLegacyConfig();
  if (!nameArg) {
    const bots = listBots();
    if (!bots.length) {
      await showLegacyStatus();
      return;
    }
    for (const bot of bots) await showNamedBotStatus(bot.name);
    return;
  }
  await showNamedBotStatus(nameArg);
}

async function showNamedBotStatus(name: string): Promise<void> {
  if (!botExists(name)) throw new Error(`Bot "${name}" does not exist.${availableBotsHint()}`);
  const config = await loadBotConfig(name);
  const { running, pid } = isBotRunning(name);
  console.log(`\n[${name}] ${running ? "running" : "stopped"}${pid ? ` (PID: ${pid})` : ""}`);
  console.log(`  Token: ${config.token ? "configured" : "missing"}`);
  console.log(`  Engine: ${config.defaultEngine}`);
  console.log(`  CWD: ${config.defaultCwd}`);
}

async function showLegacyStatus(): Promise<void> {
  const pid = await readPid(getTelegramPidPath());
  const config = await loadTelegramConfig();
  const running = Boolean(pid && isProcessRunning(pid));
  console.log(`Telegram Bot: ${running ? "running" : "stopped"}`);
  if (pid) console.log(`PID: ${pid}${running ? "" : " (stale)"}`);
  console.log(`Config: ${getTelegramConfigPath()}`);
  console.log(`Log: ${getTelegramLogPath()}`);
  console.log(`Token: ${config.token ? "configured" : "missing"}`);
  console.log(`Default: ${config.defaultEngine} / ${config.defaultPermissionMode} / ${config.defaultCwd}`);
}

async function runTelegramConfigCommand(args: string[], optionBotName?: string): Promise<void> {
  const [nameOrAction, ...rest] = args;
  if (nameOrAction === "set") {
    const [key, ...valueParts] = rest;
    if (!key || !valueParts.length) throw new Error("Usage: ai telegram config set <key> <value> [--bot <name>]");
    const config = optionBotName
      ? await setNamedBotConfigValue(optionBotName, key, valueParts.join(" "))
      : await setTelegramConfigValue(key, valueParts.join(" "));
    console.log(`Updated ${optionBotName ? `bot "${optionBotName}"` : "telegram"} config: ${key}`);
    printTelegramConfig(config, optionBotName);
    return;
  }
  if (nameOrAction === "show") {
    if (optionBotName) assertBotExists(optionBotName);
    printTelegramConfig(optionBotName ? await loadBotConfig(optionBotName) : await loadTelegramConfig(), optionBotName);
    return;
  }
  const targetName = resolveBotName(optionBotName, nameOrAction, "config");
  if (targetName) {
    await editNamedBot(targetName);
    return;
  }
  await editTelegramConfigInteractive();
}

async function editNamedBot(name: string): Promise<void> {
  assertBotExists(name);
  await editBotConfigInteractive(name);
}

async function setNamedBotConfigValue(name: string, key: string, value: string): Promise<TelegramConfig> {
  assertBotExists(name);
  return setBotConfigValue(name, key, value);
}

async function editBotConfigInteractive(name: string): Promise<void> {
  let config = await loadBotConfig(name);
  while (true) {
    console.log(`\n[${name}] config:`);
    for (const line of describeTelegramConfig(config)) console.log(`  ${line}`);
    const field = await promptSelect(`Edit ${name}`, [
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
      const engine = await promptSelect<TelegramEngineName>("Engine", [
        { label: "claude", value: "claude" },
        { label: "codex", value: "codex" }
      ]);
      config = await saveBotConfig(name, { ...config, defaultEngine: engine });
      continue;
    }
    if (field === "defaultPermissionMode") {
      const defaultPermissionMode = await promptSelect<TelegramPermissionMode>("Default permission mode", [
        { label: "bypassPermissions", value: "bypassPermissions" },
        { label: "acceptEdits", value: "acceptEdits" },
        { label: "default", value: "default" },
        { label: "readOnly", value: "readOnly" }
      ]);
      config = await saveBotConfig(name, { ...config, defaultPermissionMode });
      continue;
    }
    const current = String(config[field as keyof TelegramConfig] ?? "");
    const value = field === "token"
      ? await promptText("token (leave empty to keep current)") || current
      : await promptText(field === "proxyUrl" ? TELEGRAM_PROXY_URL_PROMPT : field, { defaultValue: current });
    config = await setBotConfigValue(name, field, value);
  }
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
    const value = field === "token"
      ? await promptText("token (leave empty to keep current)") || current
      : await promptText(field === "proxyUrl" ? TELEGRAM_PROXY_URL_PROMPT : field, { defaultValue: current });
    config = await setTelegramConfigValue(field, value);
  }
}

async function runTelegramDoctor(nameArg?: string): Promise<void> {
  if (nameArg) assertBotExists(nameArg);
  const config = nameArg ? await loadBotConfig(nameArg) : await loadTelegramConfig();
  if (!config.token) throw new Error("Telegram token is not configured.");
  const proxyUrl = getTelegramProxyUrl(config);
  console.log(`Telegram API: checking getMe${proxyUrl ? ` via ${proxyUrl}` : ""}...`);
  const result = await checkTelegramApi(config.token, proxyUrl ?? undefined);
  if (result.ok) {
    console.log(`Telegram API: ok${result.username ? ` (@${result.username})` : ""}`);
    return;
  }
  console.log(`Telegram API: failed${result.status ? ` (HTTP ${result.status})` : ""}`);
  console.log(result.error ?? "Unknown error");
}

async function showTelegramLogs(args: string[], optionBotName?: string): Promise<void> {
  const follow = args.includes("-f") || args.includes("--follow");
  const positionalName = args.find((a) => !a.startsWith("-") && !/^\d+$/.test(a));
  const nameArg = resolveBotName(optionBotName, positionalName, "logs");
  const limitArg = args.find((arg) => /^\d+$/.test(arg));
  const limit = limitArg ? Number(limitArg) : 50;

  if (nameArg) {
    assertBotExists(nameArg);
    const logPath = getTelegramBotLogPath(nameArg);
    await showLogFile(logPath, limit, follow);
    return;
  }
  const filePath = await ensureTelegramLogFile();
  const lines = await readRecentTelegramLogLines(limit);
  if (!lines.length) {
    console.log(`No Telegram logs yet: ${filePath}`);
  } else {
    for (const line of lines) console.log(formatLogLine(line));
  }
  if (follow) await followLogFile(filePath);
}

async function showLogFile(filePath: string, limit: number, follow: boolean): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n").slice(-limit);
    for (const line of lines) console.log(formatLogLine(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`No logs yet: ${filePath}`);
    } else { throw error; }
  }
  if (follow) await followLogFile(filePath);
}

function printTelegramConfig(config: TelegramConfig, botName?: string): void {
  console.log(`${botName ? `Telegram bot "${botName}"` : "Telegram"} config: ${botName ? getTelegramBotConfigPath(botName) : getTelegramConfigPath()}`);
  for (const line of describeTelegramConfig(config)) console.log(line);
}

function resolveBotName(optionName: string | undefined, positionalName: string | undefined, command: string): string | undefined {
  const positional = positionalName?.trim() || undefined;
  if (optionName && positional && optionName !== positional) {
    throw new Error(`Conflicting bot targets for ${command}: "${optionName}" and "${positional}".`);
  }
  return optionName ?? positional;
}

function resolveLifecycleTarget(target: TelegramTargetArgs, positionalName: string | undefined, command: string): string | undefined {
  if (target.all && positionalName) throw new Error(`Use either a bot name or --all for ${command}, not both.`);
  return target.all ? undefined : resolveBotName(target.botName, positionalName, command);
}

function assertNotAll(target: Pick<TelegramTargetArgs, "all">, command: string): void {
  if (target.all) throw new Error(`ai telegram ${command} does not support --all.`);
}

function assertUntargeted(target: Pick<TelegramTargetArgs, "botName" | "all">, command: string): void {
  if (target.botName || target.all) throw new Error(`ai telegram ${command} does not accept a bot target.`);
}

function assertBotExists(name: string): void {
  if (!botExists(name)) throw new Error(`Bot "${name}" does not exist.${availableBotsHint()}`);
}

function availableBotsHint(): string {
  const names = listBots().map((bot) => bot.name);
  return names.length ? ` Available bots: ${names.join(", ")}.` : " Add one with: ai telegram add <name>.";
}

async function readPid(pidPath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidPath, "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePidFile(pidPath: string, pid: number): Promise<void> {
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  await fs.writeFile(pidPath, `${pid}\n`, "utf8");
}

async function removePidFile(pidPath: string): Promise<void> {
  try { await fs.unlink(pidPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForStop(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessRunning(pid);
}

function resolveTelegramEntryPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../../telegram/index.js");
}

function formatLogLine(line: string): string {
  try {
    const event = JSON.parse(line) as { timestamp?: string; level?: string; action?: string; message?: string };
    return `[${event.timestamp ?? ""}] ${event.level ?? "info"} ${event.action ?? ""}: ${event.message ?? ""}`;
  } catch { return line; }
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
