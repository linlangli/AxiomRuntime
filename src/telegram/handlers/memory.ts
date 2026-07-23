import type { CommandContext, Context } from "grammy";
import type { MessageHandlerDeps } from "./message.js";
import { escapeHtml } from "../interaction/formatter.js";
import {
  buildMemoryClearConfirmKeyboard,
  buildMemoryManageKeyboard,
  buildRememberScopeKeyboard
} from "../interaction/keyboards.js";
import type { MemoryEntry, MemoryScope } from "../memory/types.js";
import type { TelegramSession, TelegramSetupStep } from "../session/types.js";

export type RememberScopeMode = MemoryScope | "auto";
type MemoryManageAction = "panel" | "promote" | "clear" | "clear_confirm";

export async function handleRememberCommand(ctx: CommandContext<Context>, deps: MessageHandlerDeps): Promise<void> {
  const memory = deps.memoryService;
  if (!memory) {
    await ctx.reply("Bot Memory 未启用。");
    return;
  }
  const text = String(ctx.match ?? "").trim();
  if (!text) {
    await ctx.reply("🤖 这条记忆保存到哪里？", {
      reply_markup: buildRememberScopeKeyboard()
    });
    return;
  }

  try {
    const parsed = parseRememberInput(text);
    if (parsed.kind === "pin") {
      await ctx.reply("加密记忆尚未启用，凭证类内容不会明文保存。");
      return;
    }
    if (parsed.kind === "profile") {
      const entry = memory.saveProfile(ctx.chat.id, parsed.content);
      await replySaved(ctx, entry, "用户画像已更新");
      return;
    }
    if (parsed.kind === "persona") {
      const entry = memory.savePersona(ctx.chat.id, parsed.content);
      await replySaved(ctx, entry, "Bot 人设已更新");
      return;
    }
    const entry = memory.remember(ctx.chat.id, parsed);
    await replySaved(ctx, entry, "记住了");
  } catch (error) {
    await ctx.reply(`记忆失败：<code>${escapeHtml(error instanceof Error ? error.message : String(error))}</code>`, {
      parse_mode: "HTML"
    });
  }
}

export async function handleRememberScopeCallback(
  ctx: Context,
  deps: MessageHandlerDeps,
  mode: RememberScopeMode
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (!deps.memoryService) {
    await editOrReply(ctx, "Bot Memory 未启用。", undefined, { edit: true });
    return;
  }
  const session = deps.sessionManager.getOrCreate(chatId);
  deps.sessionManager.update(session.id, { setupStep: rememberModeToStep(mode) });
  await editOrReply(ctx, "🤖 输入要记录的记忆吧", undefined, { edit: true });
}

export async function handleRememberInput(
  ctx: Context,
  deps: MessageHandlerDeps,
  text: string,
  session: TelegramSession
): Promise<boolean> {
  const mode = rememberStepToMode(session.setupStep);
  if (!mode) return false;
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  const memory = deps.memoryService;
  if (!memory) {
    deps.sessionManager.update(session.id, { setupStep: "ready" });
    await ctx.reply("Bot Memory 未启用。");
    return true;
  }

  const content = text.trim();
  if (!content) {
    await ctx.reply("🤖 输入要记录的记忆吧");
    return true;
  }

  deps.sessionManager.update(session.id, { setupStep: "ready" });
  try {
    const entry = memory.remember(chatId, {
      content,
      scope: mode === "auto" ? undefined : mode
    });
    await replySaved(ctx, entry, "记住了");
  } catch (error) {
    await ctx.reply(`记忆失败：<code>${escapeHtml(error instanceof Error ? error.message : String(error))}</code>`, {
      parse_mode: "HTML"
    });
  }
  return true;
}

export function isRememberSetupStep(step: TelegramSetupStep): boolean {
  return rememberStepToMode(step) !== null;
}

export async function handleMemoryManageInput(
  ctx: Context,
  deps: MessageHandlerDeps,
  text: string,
  session: TelegramSession
): Promise<boolean> {
  if (session.setupStep !== "memory_promote") return false;
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  const memory = deps.memoryService;
  if (!memory) {
    deps.sessionManager.update(session.id, { setupStep: "ready" });
    await ctx.reply("Bot Memory 未启用。");
    return true;
  }
  const id = Number(text.trim().replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) {
    await ctx.reply("🤖 请输入要升级的记忆编号，例如 12");
    return true;
  }
  deps.sessionManager.update(session.id, { setupStep: "ready" });
  try {
    const entry = memory.promote(chatId, id);
    await ctx.reply(entry ? `🤖 已升级为 global：<code>#${entry.id}</code>` : "🤖 只能升级当前 bot 的记忆。", {
      parse_mode: "HTML"
    });
  } catch (error) {
    await ctx.reply(`升级失败：<code>${escapeHtml(error instanceof Error ? error.message : String(error))}</code>`, {
      parse_mode: "HTML"
    });
  }
  return true;
}

export async function handleForgetCommand(ctx: CommandContext<Context>, deps: MessageHandlerDeps): Promise<void> {
  const memory = deps.memoryService;
  if (!memory) {
    await ctx.reply("Bot Memory 未启用。");
    return;
  }
  const selector = String(ctx.match ?? "").trim();
  if (!selector) {
    await ctx.reply("用法：/forget <编号或关键词>");
    return;
  }
  const count = memory.delete(ctx.chat.id, selector);
  await ctx.reply(count > 0 ? `🤖 已删除 ${count} 条记忆。` : "🤖 没有找到匹配的记忆。");
}

export async function handleMemoriesCommand(ctx: CommandContext<Context>, deps: MessageHandlerDeps): Promise<void> {
  const memory = deps.memoryService;
  if (!memory) {
    await ctx.reply("Bot Memory 未启用。");
    return;
  }
  const text = String(ctx.match ?? "").trim();
  const query = text.startsWith("search ") ? text.slice("search ".length).trim() : text;
  await ctx.reply(memory.formatList(ctx.chat.id, query || undefined), { parse_mode: "HTML" });
}

export async function handleMemoryCommand(ctx: CommandContext<Context>, deps: MessageHandlerDeps): Promise<void> {
  const memory = deps.memoryService;
  if (!memory) {
    await ctx.reply("Bot Memory 未启用。");
    return;
  }
  const text = String(ctx.match ?? "").trim();
  if (!text) {
    await showMemoryPanel(ctx);
    return;
  }
  const [command, first, second] = text.split(/\s+/);
  if (command === "promote" && /^\d+$/.test(first ?? "")) {
    try {
      const entry = memory.promote(ctx.chat.id, Number(first));
      await ctx.reply(entry ? `🤖 已升级为 global：<code>#${entry.id}</code>` : "🤖 只能升级当前 bot 的记忆。", {
        parse_mode: "HTML"
      });
    } catch (error) {
      await ctx.reply(`升级失败：<code>${escapeHtml(error instanceof Error ? error.message : String(error))}</code>`, {
        parse_mode: "HTML"
      });
    }
    return;
  }
  if (command === "clear" && (first === "bot" || first === "global")) {
    if (second !== "confirm") {
      await askMemoryClearConfirm(ctx, first);
      return;
    }
    const count = memory.clearScope(ctx.chat.id, first);
    await ctx.reply(`🤖 已清空 ${first} 记忆 ${count} 条。`);
    return;
  }
  if (command === "pin" || command === "unlock" || command === "lock") {
    await ctx.reply("加密记忆尚未启用。");
    return;
  }
  if (command === "export" || command === "import") {
    await ctx.reply("Memory export/import 将在后续阶段启用。");
    return;
  }
  await showMemoryPanel(ctx);
}

export async function handleMemoryManageCallback(
  ctx: Context,
  deps: MessageHandlerDeps,
  action: MemoryManageAction,
  scope?: string
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const memory = deps.memoryService;
  if (!memory) {
    await editOrReply(ctx, "Bot Memory 未启用。", undefined, { edit: true });
    return;
  }
  if (action === "panel") {
    await showMemoryPanel(ctx, { edit: true });
    return;
  }
  if (action === "promote") {
    const session = deps.sessionManager.getOrCreate(chatId);
    deps.sessionManager.update(session.id, { setupStep: "memory_promote" });
    await editOrReply(ctx, "🤖 输入要升级为 global 的记忆编号吧", undefined, { edit: true });
    return;
  }
  if (action === "clear" && isMemoryScope(scope)) {
    await askMemoryClearConfirm(ctx, scope, { edit: true });
    return;
  }
  if (action === "clear_confirm" && isMemoryScope(scope)) {
    const session = deps.sessionManager.getOrCreate(chatId);
    deps.sessionManager.update(session.id, { setupStep: "ready" });
    const count = memory.clearScope(chatId, scope);
    await editOrReply(ctx, `🤖 已清空 ${scope} 记忆 ${count} 条。`, {
      parse_mode: "HTML",
      reply_markup: buildMemoryManageKeyboard()
    }, { edit: true });
    return;
  }
  await showMemoryPanel(ctx, { edit: true });
}

type ParsedRememberInput =
  | { kind: "profile"; content: string }
  | { kind: "persona"; content: string }
  | { kind: "pin"; content: string }
  | { kind?: undefined; content: string; scope?: MemoryScope; duration?: "short_term"; ttlMs?: number };

function parseRememberInput(text: string): ParsedRememberInput {
  const [command, ...rest] = text.split(/\s+/);
  const content = rest.join(" ").trim();
  if (command === "profile" && content) return { kind: "profile", content };
  if (command === "persona" && content) return { kind: "persona", content };
  if (command === "pin" && content) return { kind: "pin", content };
  if (command === "global" && content) return { scope: "global", content };
  if (command === "bot" && content) return { scope: "bot", content };
  if (command === "temp") {
    const parsed = parseTempMemory(rest.join(" "));
    if (parsed) return parsed;
  }
  return { content: text };
}

function parseTempMemory(value: string): ParsedRememberInput | null {
  const text = value.trim();
  const match = text.match(/^(\d+)([hd])\s+([\s\S]+)$/);
  if (!match) return text ? { content: text, scope: "bot", duration: "short_term" } : null;
  const amount = Number(match[1]);
  const unit = match[2];
  const content = match[3]?.trim();
  if (!content || !Number.isFinite(amount) || amount <= 0) return null;
  const ttlMs = amount * (unit === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
  return { content, scope: "bot", duration: "short_term", ttlMs };
}

function rememberModeToStep(mode: RememberScopeMode): TelegramSetupStep {
  if (mode === "global") return "remember_global";
  if (mode === "bot") return "remember_bot";
  return "remember_auto";
}

function rememberStepToMode(step: TelegramSetupStep): RememberScopeMode | null {
  if (step === "remember_global") return "global";
  if (step === "remember_bot") return "bot";
  if (step === "remember_auto") return "auto";
  return null;
}

function isMemoryScope(value: string | undefined): value is MemoryScope {
  return value === "bot" || value === "global";
}

async function showMemoryPanel(ctx: Pick<Context, "reply" | "editMessageText">, options: { edit?: boolean } = {}): Promise<void> {
  await editOrReply(ctx as Context, "🤖 选择你要管理的记忆操作吧", {
    reply_markup: buildMemoryManageKeyboard()
  }, options);
}

async function askMemoryClearConfirm(
  ctx: Pick<Context, "reply" | "editMessageText">,
  scope: MemoryScope,
  options: { edit?: boolean } = {}
): Promise<void> {
  await editOrReply(ctx as Context, `🤖 确认清空 ${scope} 记忆吗？`, {
    reply_markup: buildMemoryClearConfirmKeyboard(scope)
  }, options);
}

type ReplyExtra = Parameters<Context["reply"]>[1];
type EditExtra = Parameters<Context["editMessageText"]>[1];

async function editOrReply(
  ctx: Context,
  text: string,
  extra?: ReplyExtra,
  options: { edit?: boolean } = {}
): Promise<void> {
  if (!options.edit) {
    await ctx.reply(text, extra);
    return;
  }
  try {
    await ctx.editMessageText(text, extra as EditExtra);
    return;
  } catch {
    // The source message may not be editable; replying keeps the flow usable.
  }
  await ctx.reply(text, extra);
}

async function replySaved(ctx: Pick<Context, "reply">, entry: MemoryEntry, message: string): Promise<void> {
  await ctx.reply([
    `🤖 ${escapeHtml(message)}：<code>#${entry.id}</code>`,
    `Scope：<code>${escapeHtml(entry.scope)}</code> · Category：<code>${escapeHtml(entry.category)}</code>`
  ].join("\n"), { parse_mode: "HTML" });
}
