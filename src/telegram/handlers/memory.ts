import type { CommandContext, Context } from "grammy";
import type { MessageHandlerDeps } from "./message.js";
import { escapeHtml } from "../interaction/formatter.js";
import type { MemoryScope } from "../memory/types.js";

export async function handleRememberCommand(ctx: CommandContext<Context>, deps: MessageHandlerDeps): Promise<void> {
  const memory = deps.memoryService;
  if (!memory) {
    await ctx.reply("Bot Memory 未启用。");
    return;
  }
  const text = String(ctx.match ?? "").trim();
  if (!text) {
    await ctx.reply("用法：/remember <内容>，或 /remember global|bot|profile|persona|temp <内容>");
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
      await replySaved(ctx, entry.id, "用户画像已更新");
      return;
    }
    if (parsed.kind === "persona") {
      const entry = memory.savePersona(ctx.chat.id, parsed.content);
      await replySaved(ctx, entry.id, "Bot 人设已更新");
      return;
    }
    const entry = memory.remember(ctx.chat.id, parsed);
    await replySaved(ctx, entry.id, "记住了");
  } catch (error) {
    await ctx.reply(`记忆失败：<code>${escapeHtml(error instanceof Error ? error.message : String(error))}</code>`, {
      parse_mode: "HTML"
    });
  }
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
      await ctx.reply(`请确认：/memory clear ${first} confirm`);
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
  await ctx.reply([
    "用法：",
    "/memory promote <编号>",
    "/memory clear bot confirm",
    "/memory clear global confirm"
  ].join("\n"));
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

async function replySaved(ctx: CommandContext<Context>, id: number, message: string): Promise<void> {
  await ctx.reply(`🤖 ${escapeHtml(message)}：<code>#${id}</code>`, { parse_mode: "HTML" });
}
