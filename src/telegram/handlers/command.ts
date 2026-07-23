import fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { InputFile, type Bot, type CommandContext, type Context } from "grammy";
import type { TelegramConfig, TelegramEngineName } from "../config.js";
import type { Engine } from "../engine/types.js";
import { createCommandPermissionRequest } from "../engine/engine-utils.js";
import { requiresDangerousConfirmation } from "../interaction/approval.js";
import { safeResetChatCommandMenu, safeSetChatCommandMenu } from "../interaction/command-menu.js";
import { Formatter, escapeHtml } from "../interaction/formatter.js";
import type { ApprovalManager } from "../interaction/approval.js";
import type { SessionManager } from "../session/manager.js";
import { runCliInit, type MessageHandlerDeps } from "./message.js";
import { handleForgetCommand, handleMemoriesCommand, handleMemoryCommand, handleRememberCommand } from "./memory.js";
import { showProviderAdminPanel } from "./provider.js";
import { showConfigPanel, showReadyProviderPicker, showSetupProviderPicker, showWorkdirStart, startSetup } from "./setup.js";
import { showUsagePanel } from "./usage.js";
import { writeTelegramLog } from "../log.js";

const execAsync = promisify(exec);
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

  bot.command("stop", async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    if (session.status !== "running" && session.status !== "waiting_approval") {
      await ctx.reply("当前没有正在运行的任务。");
      return;
    }
    deps.engines.claude.abort(ctx.chat.id);
    deps.engines.codex.abort(ctx.chat.id);
    deps.approvalManager.resolveAll(ctx.chat.id, false);
    deps.sessionManager.update(session.id, { status: "idle" });
    const hasLastMessage = session.conversation.length > 0;
    await ctx.reply("已停止当前任务。", hasLastMessage ? {
      reply_markup: { inline_keyboard: [[{ text: "🔁 重新执行上一条", callback_data: "retry:last" }]] }
    } : undefined);
  });

  bot.command("fresh", async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    if (session.status === "running" || session.status === "waiting_approval") {
      await ctx.reply("已有任务正在运行，请等待完成。");
      return;
    }
    await ctx.reply(Formatter.sessionCleared(session), { parse_mode: "HTML" });
    await deleteRecentChatMessages(ctx, ctx.chat.id, ctx.message?.message_id);
  });

  bot.command("config", async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    await showConfigPanel(ctx, deps, session);
  });

  bot.command("model", async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    if (session.setupStep === "ready") {
      await showReadyProviderPicker(ctx, deps, { reselect: true });
      return;
    }
    await showSetupProviderPicker(ctx, deps, { reselect: true });
  });

  bot.command("provider", async (ctx) => {
    await showProviderAdminPanel(ctx);
  });

  bot.command("usage", async (ctx) => {
    await showUsagePanel(ctx, deps);
  });

  bot.command("remember", async (ctx) => {
    await handleRememberCommand(ctx, deps);
  });

  bot.command("forget", async (ctx) => {
    await handleForgetCommand(ctx, deps);
  });

  bot.command("memories", async (ctx) => {
    await handleMemoriesCommand(ctx, deps);
  });

  bot.command("memory", async (ctx) => {
    await handleMemoryCommand(ctx, deps);
  });

  bot.command("usge", async (ctx) => {
    await showUsagePanel(ctx, deps);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(Formatter.help(), { parse_mode: "HTML" });
  });

  bot.command("claude", async (ctx) => {
    await runEngineCommand(ctx, deps, bot, "claude");
  });

  bot.command("codex", async (ctx) => {
    await runEngineCommand(ctx, deps, bot, "codex");
  });

  bot.command("cwd", async (ctx) => {
    const cwd = String(ctx.match ?? "").trim();
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    if (!cwd) {
      deps.sessionManager.update(session.id, { setupStep: "ready" });
      await showWorkdirStart(ctx, deps, { scope: "ready", prompt: Formatter.workdirChangePrompt() });
      return;
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      await ctx.reply(`Directory not found: <code>${escapeHtml(cwd)}</code>`, { parse_mode: "HTML" });
      return;
    }
    const next = deps.sessionManager.update(session.id, {
      cwd,
      engineSessionId: null,
      botContextFingerprint: null
    });
    await runCliInit(ctx, deps, next.engine);
    const customCommands = deps.sessionManager.listCustomCommands(ctx.chat.id, cwd);
    await safeSetChatCommandMenu(bot, ctx.chat.id, next.engine, customCommands);
    await ctx.reply(`cwd: <code>${escapeHtml(cwd)}</code>`, { parse_mode: "HTML" });
  });

  bot.command("command", async (ctx) => {
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    const next = deps.sessionManager.update(session.id, { setupStep: "command_name" });
    void writeTelegramLog({ action: "command_register_start", message: `chatId=${ctx.chat.id} sessionId=${session.id} before=${session.setupStep} after=${next.setupStep}` });
    await ctx.reply(Formatter.commandNamePrompt(), {
      reply_markup: { inline_keyboard: [[{ text: "关闭", callback_data: "command:cancel" }]] }
    });
  });

  bot.command("pin", async (ctx) => {
    const reply = ctx.message?.reply_to_message;
    if (!reply) {
      await ctx.reply("用法：回复一条 bot 消息并发送 /pin 来固定该对话。");
      return;
    }
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    const replyText = "text" in reply ? reply.text : "caption" in reply ? reply.caption : undefined;
    const normalizedReply = normalizePinText(replyText ?? "");
    const turn = [...session.conversation].reverse().find((item) => {
      const assistant = normalizePinText(item.assistant);
      const sample = assistant.slice(0, Math.min(80, assistant.length));
      return Boolean(sample && (normalizedReply.includes(sample) || assistant.includes(normalizedReply)));
    });
    if (!turn) {
      await ctx.reply("未找到对应的对话记录，只能固定 bot 回复的消息。");
      return;
    }
    deps.sessionManager.pinTurn(ctx.chat.id, reply.message_id, { user: turn.user, assistant: turn.assistant });
    await ctx.reply("📌 已固定该对话，后续请求会优先携带此上下文。");
  });

  bot.command("unpin", async (ctx) => {
    const reply = ctx.message?.reply_to_message;
    if (!reply) {
      const session = deps.sessionManager.getOrCreate(ctx.chat.id);
      if (!session.pinnedTurns.length) {
        await ctx.reply("当前没有固定的对话。");
        return;
      }
      deps.sessionManager.unpinTurn(ctx.chat.id, session.pinnedTurns[session.pinnedTurns.length - 1]!.messageId);
      await ctx.reply("已取消最近一条固定对话。");
      return;
    }
    deps.sessionManager.unpinTurn(ctx.chat.id, reply.message_id);
    await ctx.reply("已取消固定该对话。");
  });

  bot.command("terminal", async (ctx) => {
    const shell = String(ctx.match ?? "").trim();
    if (!shell) {
      await ctx.reply("用法：<code>/terminal &lt;命令&gt;</code>\n例如：<code>/terminal ls -la</code>", { parse_mode: "HTML" });
      return;
    }
    const session = deps.sessionManager.getOrCreate(ctx.chat.id);
    const cwd = session.cwd || process.cwd();
    if (requiresDangerousConfirmation(shell)) {
      deps.sessionManager.update(session.id, { status: "waiting_approval" });
      const approved = await deps.approvalManager.request(
        ctx.chat.id,
        createCommandPermissionRequest("Telegram terminal", shell)
      );
      deps.sessionManager.update(session.id, { status: "idle" });
      if (!approved) {
        await ctx.reply("已取消高风险终端命令。");
        return;
      }
    }
    await ctx.reply(`⚙️ 执行中：<code>${escapeHtml(shell)}</code>`, { parse_mode: "HTML" });
    try {
      const { stdout, stderr } = await execAsync(shell, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
      const output = (stdout || stderr || "（无输出）").trim();
      if (output.length <= 3800) {
        await ctx.reply(`<pre>${escapeHtml(output)}</pre>`, { parse_mode: "HTML" });
      } else {
        await ctx.replyWithDocument(new InputFile(Buffer.from(output, "utf-8"), "output.txt"));
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.length <= 3800) {
        await ctx.reply(`❌ 执行失败：\n<pre>${escapeHtml(msg)}</pre>`, { parse_mode: "HTML" });
      } else {
        await ctx.replyWithDocument(new InputFile(Buffer.from(msg, "utf-8"), "error.txt"));
      }
    }
  });

  bot.command("restart", async (ctx) => {
    await ctx.reply("🔄 Bot 正在重启…");
    setTimeout(() => process.kill(process.pid, "SIGHUP"), 500).unref?.();
  });
}

function normalizePinText(value: string): string {
  return value
    .replace(/^✅\s*完成(?:\s*·[^\n]+)?/u, "")
    .replace(/\s+/g, " ")
    .trim();
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

async function runEngineCommand(ctx: CommandContext<Context>, deps: CommandDeps, bot: Bot, engine: TelegramEngineName): Promise<void> {
  const session = deps.sessionManager.getOrCreate(ctx.chat.id);
  if (session.setupStep !== "ready") {
    await showSetupProviderPicker(ctx, deps, { forcedEngine: engine, reselect: true });
    return;
  }
  const customCommands = deps.sessionManager.listCustomCommands(ctx.chat.id, session.cwd);
  await safeSetChatCommandMenu(bot, ctx.chat.id, engine, customCommands);
  await showReadyProviderPicker(ctx, deps, { forcedEngine: engine, reselect: true });
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
