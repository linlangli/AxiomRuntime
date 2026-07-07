import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot, Context } from "grammy";
import { resolveProviderForTool } from "../../core/runner/fallback.js";
import type { TelegramEngineName } from "../config.js";
import { safeSetChatCommandMenu } from "../interaction/command-menu.js";
import { Formatter } from "../interaction/formatter.js";
import { buildCliKeyboard, buildWorkdirListKeyboard, buildWorkdirStartKeyboard } from "../interaction/keyboards.js";
import type { SessionManager } from "../session/manager.js";
import type { TelegramSession } from "../session/types.js";

export type SetupDeps = {
  sessionManager: SessionManager;
  bot?: Bot;
};

export async function startSetup(ctx: Context, deps: SetupDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  deps.sessionManager.startSetup(chatId);
  const workdirs = deps.sessionManager.getWorkdirs(chatId);
  await ctx.reply(Formatter.workdirPrompt(), {
    parse_mode: "HTML",
    reply_markup: buildWorkdirStartKeyboard(workdirs.length > 0)
  });
}

export async function showWorkdirList(ctx: Context, deps: SetupDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const workdirs = deps.sessionManager.getWorkdirs(chatId);
  await ctx.reply(Formatter.workdirList(workdirs), {
    parse_mode: "HTML",
    reply_markup: buildWorkdirListKeyboard(workdirs)
  });
}

export async function askCustomWorkdir(ctx: Context, deps: SetupDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  deps.sessionManager.update(session.id, { setupStep: "custom_workdir" });
  await ctx.reply(Formatter.customWorkdirPrompt(), { parse_mode: "HTML" });
}

export async function setWorkdir(ctx: Context, deps: SetupDeps, rawPath: string, options: { fromCustomInput?: boolean } = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const cwd = options.fromCustomInput ? resolveHomeChild(rawPath) : expandHome(rawPath.trim());
  if (!cwd || cwd === os.homedir()) {
    await ctx.reply(Formatter.workdirRequired(), { parse_mode: "HTML" });
    return;
  }
  fs.mkdirSync(cwd, { recursive: true });
  const next = deps.sessionManager.update(session.id, { cwd, setupStep: "cli" });
  deps.sessionManager.rememberWorkdir(chatId, cwd);
  await ctx.reply(Formatter.cliPrompt(next.cwd), {
    parse_mode: "HTML",
    reply_markup: buildCliKeyboard()
  });
}

export async function selectCli(ctx: Context, deps: SetupDeps, engine: TelegramEngineName): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  if (session.setupStep === "workdir" || session.setupStep === "custom_workdir") {
    await ctx.reply(Formatter.workdirRequired(), { parse_mode: "HTML" });
    return;
  }
  const next = deps.sessionManager.update(session.id, { engine, setupStep: "ready" });
  deps.sessionManager.rememberWorkdir(chatId, next.cwd);
  if (deps.bot) {
    await safeSetChatCommandMenu(deps.bot, chatId, engine);
  }
  await showReadyCard(ctx, next);
}

export async function remindSetup(ctx: Context, session: TelegramSession): Promise<boolean> {
  if (session.setupStep === "workdir" || session.setupStep === "custom_workdir") {
    await ctx.reply(Formatter.workdirRequired(), { parse_mode: "HTML" });
    return true;
  }
  if (session.setupStep === "cli") {
    await ctx.reply(Formatter.cliRequired(), {
      parse_mode: "HTML",
      reply_markup: buildCliKeyboard()
    });
    return true;
  }
  return false;
}

export async function showReadyCard(ctx: Context, session: TelegramSession): Promise<void> {
  const resolved = await getResolvedProvider(session.engine);
  await ctx.reply(Formatter.sessionCard(session, resolved.provider, resolved.error), { parse_mode: "HTML" });
}

async function getResolvedProvider(engine: TelegramEngineName): Promise<{ provider?: { name: string; model: string }; error?: string }> {
  try {
    const resolved = await resolveProviderForTool(engine);
    return { provider: { name: resolved.provider.name, model: resolved.model } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveHomeChild(value: string): string {
  const name = value.trim().replace(/^~\//, "").replace(/^\/+/, "");
  return path.join(os.homedir(), name);
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
