import fs from "node:fs";
import { type Bot, type CommandContext, type Context } from "grammy";
import type { TelegramConfig, TelegramEngineName } from "../config.js";
import type { Engine } from "../engine/types.js";
import { safeResetChatCommandMenu } from "../interaction/command-menu.js";
import { Formatter, escapeHtml } from "../interaction/formatter.js";
import type { ApprovalManager } from "../interaction/approval.js";
import type { SessionManager } from "../session/manager.js";
import { executePrompt, type MessageHandlerDeps } from "./message.js";
import { selectCli, startSetup } from "./setup.js";

type CommandDeps = MessageHandlerDeps & {
  engines: Record<TelegramEngineName, Engine>;
  approvalManager: ApprovalManager;
  sessionManager: SessionManager;
  config: TelegramConfig;
};

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  bot.command("start", async (ctx) => {
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
