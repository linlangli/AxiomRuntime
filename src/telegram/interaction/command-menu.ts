import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import type { BotCommand } from "@grammyjs/types";
import type { TelegramEngineName } from "../config.js";
import { writeTelegramLog } from "../log.js";

export type TelegramCommandMapping = {
  command: string;
  description: string;
  prompt: string;
};

const MAX_TELEGRAM_COMMANDS = 100;

const BASE_COMMANDS: TelegramCommandMapping[] = [
  { command: "claude", description: "使用 Claude Code", prompt: "/claude" },
  { command: "codex", description: "使用 Codex", prompt: "/codex" },
  { command: "reset", description: "重新选择工作路径和 CLI", prompt: "/reset" },
  { command: "cwd", description: "查看或切换工作路径", prompt: "/cwd" },
  { command: "help", description: "查看帮助", prompt: "/help" }
];

const BUILTIN_CLI_COMMANDS: Record<TelegramEngineName, TelegramCommandMapping[]> = {
  claude: [
    { command: "add_dir", description: "Claude Code: add working directories", prompt: "/add-dir" },
    { command: "agents", description: "Claude Code: manage agents", prompt: "/agents" },
    { command: "clear", description: "Claude Code: clear conversation", prompt: "/clear" },
    { command: "compact", description: "Claude Code: compact context", prompt: "/compact" },
    { command: "config", description: "Claude Code: open config", prompt: "/config" },
    { command: "cost", description: "Claude Code: show cost", prompt: "/cost" },
    { command: "doctor", description: "Claude Code: health check", prompt: "/doctor" },
    { command: "help_claude", description: "Claude Code: slash command help", prompt: "/help" },
    { command: "ide", description: "Claude Code: manage IDE connection", prompt: "/ide" },
    { command: "init", description: "Claude Code: initialize project memory", prompt: "/init" },
    { command: "login", description: "Claude Code: login", prompt: "/login" },
    { command: "logout", description: "Claude Code: logout", prompt: "/logout" },
    { command: "mcp", description: "Claude Code: manage MCP", prompt: "/mcp" },
    { command: "memory", description: "Claude Code: edit memory", prompt: "/memory" },
    { command: "model", description: "Claude Code: switch model", prompt: "/model" },
    { command: "permissions", description: "Claude Code: manage permissions", prompt: "/permissions" },
    { command: "pr_comments", description: "Claude Code: view PR comments", prompt: "/pr-comments" },
    { command: "resume", description: "Claude Code: resume conversation", prompt: "/resume" },
    { command: "review", description: "Claude Code: review changes", prompt: "/review" },
    { command: "status", description: "Claude Code: show status", prompt: "/status" },
    { command: "terminal_setup", description: "Claude Code: terminal setup", prompt: "/terminal-setup" },
    { command: "vim", description: "Claude Code: toggle vim mode", prompt: "/vim" }
  ],
  codex: [
    { command: "clear", description: "Codex: clear conversation", prompt: "/clear" },
    { command: "compact", description: "Codex: compact context", prompt: "/compact" },
    { command: "help_codex", description: "Codex: slash command help", prompt: "/help" },
    { command: "init", description: "Codex: initialize project instructions", prompt: "/init" },
    { command: "model", description: "Codex: switch model", prompt: "/model" },
    { command: "new", description: "Codex: new conversation", prompt: "/new" },
    { command: "review", description: "Codex: review changes", prompt: "/review" },
    { command: "status", description: "Codex: show status", prompt: "/status" }
  ]
};

export function getBaseBotCommands(): BotCommand[] {
  return BASE_COMMANDS.map(toBotCommand);
}

export function getChatBotCommands(engine: TelegramEngineName): BotCommand[] {
  return getCommandMappings(engine).map(toBotCommand).slice(0, MAX_TELEGRAM_COMMANDS);
}

export function getCommandMappings(engine: TelegramEngineName): TelegramCommandMapping[] {
  return mergeCommandMappings([
    ...BASE_COMMANDS,
    ...BUILTIN_CLI_COMMANDS[engine],
    ...readConfiguredCommands(engine)
  ]);
}

export function resolveMappedCommand(engine: TelegramEngineName, command: string): TelegramCommandMapping | null {
  const normalized = normalizeTelegramCommandName(command);
  return getCommandMappings(engine).find((item) => item.command === normalized) ?? null;
}

export async function setDefaultCommandMenu(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(getBaseBotCommands());
}

export async function setChatCommandMenu(bot: Bot, chatId: number, engine: TelegramEngineName): Promise<void> {
  await bot.api.setMyCommands(getChatBotCommands(engine), {
    scope: { type: "chat", chat_id: chatId }
  });
}

export async function resetChatCommandMenu(bot: Bot, chatId: number): Promise<void> {
  await bot.api.deleteMyCommands({
    scope: { type: "chat", chat_id: chatId }
  });
}

export async function safeSetDefaultCommandMenu(bot: Bot): Promise<void> {
  try {
    await setDefaultCommandMenu(bot);
  } catch (error) {
    await writeTelegramLog({
      level: "warn",
      action: "set_commands_failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function safeSetChatCommandMenu(bot: Bot, chatId: number, engine: TelegramEngineName): Promise<void> {
  try {
    await setChatCommandMenu(bot, chatId, engine);
  } catch (error) {
    await writeTelegramLog({
      level: "warn",
      action: "set_chat_commands_failed",
      message: error instanceof Error ? error.message : String(error),
      metadata: { chatId, engine }
    });
  }
}

export async function safeResetChatCommandMenu(bot: Bot, chatId: number): Promise<void> {
  try {
    await resetChatCommandMenu(bot, chatId);
  } catch (error) {
    await writeTelegramLog({
      level: "warn",
      action: "reset_chat_commands_failed",
      message: error instanceof Error ? error.message : String(error),
      metadata: { chatId }
    });
  }
}

export function parseTelegramCommand(text: string): { command: string; args: string } | null {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    command: normalizeTelegramCommandName(match[1] ?? ""),
    args: (match[2] ?? "").trim()
  };
}

function toBotCommand(mapping: TelegramCommandMapping): BotCommand {
  return {
    command: mapping.command,
    description: truncateDescription(mapping.description)
  };
}

function readConfiguredCommands(engine: TelegramEngineName): TelegramCommandMapping[] {
  const roots = getCommandRoots(engine);
  const commands: TelegramCommandMapping[] = [];
  for (const root of roots) {
    commands.push(...readCommandFiles(root, root));
  }
  return commands;
}

function getCommandRoots(engine: TelegramEngineName): string[] {
  const home = os.homedir();
  if (engine === "claude") {
    return [
      path.join(home, ".claude", "commands"),
      path.join(home, ".config", "ai", "claude", "commands"),
      path.join(home, ".config", "ai", "claude", "plugins", "cache"),
      path.join(home, ".config", "ai", "claude", "plugins", "marketplaces")
    ];
  }
  return [
    path.join(home, ".codex", "commands"),
    path.join(home, ".config", "ai", "codex", "commands"),
    path.join(home, ".config", "ai", "codex", "plugins", "cache")
  ];
}

function readCommandFiles(root: string, current: string, depth = 0): TelegramCommandMapping[] {
  if (!fs.existsSync(current) || depth > 8) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: TelegramCommandMapping[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const filePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      results.push(...readCommandFiles(root, filePath, depth + 1));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const mapping = commandFromMarkdown(root, filePath);
    if (mapping) results.push(mapping);
  }
  return results;
}

function commandFromMarkdown(root: string, filePath: string): TelegramCommandMapping | null {
  const originalName = path.basename(filePath, ".md");
  const command = normalizeTelegramCommandName(originalName);
  if (!command) return null;

  let description = `${originalName} command`;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const descriptionLine = content.match(/^description:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim();
    description = descriptionLine || title || description;
  } catch {
    // Keep the fallback description when command metadata is unreadable.
  }

  return {
    command,
    description,
    prompt: `/${originalName}`
  };
}

function mergeCommandMappings(commands: TelegramCommandMapping[]): TelegramCommandMapping[] {
  const seen = new Set<string>();
  const result: TelegramCommandMapping[] = [];
  for (const command of commands) {
    const normalized = normalizeTelegramCommandName(command.command);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({
      command: normalized,
      description: truncateDescription(command.description || command.prompt),
      prompt: command.prompt
    });
  }
  return result.slice(0, MAX_TELEGRAM_COMMANDS);
}

function normalizeTelegramCommandName(value: string): string {
  return value
    .trim()
    .replace(/^\//, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function truncateDescription(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim() || "Run command";
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}
