import fs from "node:fs";
import { type Bot, type CommandContext, type Context } from "grammy";
import type { TelegramConfig, TelegramEngineName } from "../config.js";
import type { Engine } from "../engine/types.js";
import { safeResetChatCommandMenu } from "../interaction/command-menu.js";
import { Formatter, escapeHtml } from "../interaction/formatter.js";
import type { ApprovalManager } from "../interaction/approval.js";
import type { SessionManager } from "../session/manager.js";
import { executePrompt, type MessageHandlerDeps } from "./message.js";
import { selectCli, showConfigPanel, startSetup } from "./setup.js";
import { showUsagePanel } from "./usage.js";

const FRESH_DELETE_SCAN_LIMIT = 1000;
const TELEGRAM_DELETE_BATCH_SIZE = 100;
const START_COMMAND_DEDUP_MS = 10000;
const recentStartCommands = new Map<number, number>();

type CommandDeps = MessageHandlerDeps & {
  engines: Record<TelegramEngineName, Engine>;
  approvalManager: ApprovalManager;
  sessionManager: SessionManager;
  config: TelegramConfig;
};

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  bot.command("start", async (ctx) => {
    if (!shouldHandleStartCommand(ctx.chat.id)) {
      await safeDeleteCommandMessage(ctx);
      return;
    }
    await safeResetChatCommandMenu(bot, ctx.chat.id);
    await startSetup(ctx, deps);
  });

  bot.command("reset", async (ctx) => {
    deps.engines.claude.abort(ctx.chat.id);
    deps.engines.codex.abort(ctx.chat.id);
    deps.approvalManager.resolveAll(ctx.chat.id, false);
    await safeResetChatCommandMenu(bot, ctx.chat.id);
    await startSetup(ctx, deps);
  });

  bot.command("fresh", async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    if (session.status === "running" || session.status === "waiting_approval") {
      await ctx.reply("已有任务正在运行，请等待完成。");
      return;
    }
    const cleared = deps.sessionManager.clearConversation(ctx.chat.id);
    await ctx.reply(Formatter.sessionCleared(cleared), { parse_mode: "HTML" });
    await deleteRecentChatMessages(ctx, ctx.chat.id, ctx.message?.message_id);
  });

  bot.command("config", async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    await showConfigPanel(ctx, deps, session);
  });

  bot.command("usage", async (ctx) => {
    await showUsagePanel(ctx, deps);
  });

  bot.command("usge", async (ctx) => {
    await showUsagePanel(ctx, deps);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(Formatter.help(), { parse_mode: "HTML" });
  });

  bot.command("claude", async (ctx) => {
    await runEngineCommand(ctx, deps, "claude");
  });

  bot.command("codex", async (ctx) => {
    await runEngineCommand(ctx, deps, "codex");
  });

  bot.command("cwd", async (ctx) => {
    const cwd = String(ctx.match ?? "").trim();
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    if (!cwd) {
      await ctx.reply(`cwd: <code>${escapeHtml(session.cwd)}</code>`, { parse_mode: "HTML" });
      return;
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      await ctx.reply(`Directory not found: <code>${escapeHtml(cwd)}</code>`, { parse_mode: "HTML" });
      return;
    }
    deps.sessionManager.update(session.id, { cwd });
    await ctx.reply(`cwd: <code>${escapeHtml(cwd)}</code>`, { parse_mode: "HTML" });
  });
}

export function shouldHandleStartCommand(
  chatId: number,
  now = Date.now(),
  recent = recentStartCommands
): boolean {
  const previous = recent.get(chatId);
  recent.set(chatId, now);
  return !previous || now - previous > START_COMMAND_DEDUP_MS;
}

async function safeDeleteCommandMessage(ctx: CommandContext<Context>): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch {
    // The duplicate /start prompt is best-effort cleanup only.
  }
}

async function runEngineCommand(ctx: CommandContext<Context>, deps: CommandDeps, engine: TelegramEngineName): Promise<void> {
  const prompt = String(ctx.match ?? "").trim();
  const session = deps.sessionManager.getOrCreate(ctx.chat.id);
  if (session.setupStep !== "ready") {
    await selectCli(ctx, deps, engine);
    return;
  }
  deps.sessionManager.update(session.id, { engine, setupStep: "ready" });
  if (!prompt) {
    await selectCli(ctx, deps, engine);
    return;
  }
  await executePrompt(ctx, deps, prompt, engine);
}

export async function deleteRecentChatMessages(
  ctx: Pick<Context, "api">,
  chatId: number,
  fromMessageId: number | undefined,
  scanLimit = FRESH_DELETE_SCAN_LIMIT
): Promise<number> {
  if (!fromMessageId || scanLimit <= 0) return 0;
  const messageIds: number[] = [];
  for (let messageId = fromMessageId; messageId > 0 && messageIds.length < scanLimit; messageId -= 1) {
    messageIds.push(messageId);
  }

  let deleted = 0;
  for (let index = 0; index < messageIds.length; index += TELEGRAM_DELETE_BATCH_SIZE) {
    const batch = messageIds.slice(index, index + TELEGRAM_DELETE_BATCH_SIZE);
    try {
      await ctx.api.deleteMessages(chatId, batch);
      deleted += batch.length;
    } catch {
      deleted += await deleteMessagesIndividually(ctx, chatId, batch);
    }
  }
  return deleted;
}

async function deleteMessagesIndividually(
  ctx: Pick<Context, "api">,
  chatId: number,
  messageIds: number[]
): Promise<number> {
  let deleted = 0;
  for (const messageId of messageIds) {
    try {
      await ctx.api.deleteMessage(chatId, messageId);
      deleted += 1;
    } catch {
      // Old, already deleted, or unauthorized messages are skipped.
    }
  }
  return deleted;
}
