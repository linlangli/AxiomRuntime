import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Bot, Context } from "grammy";
import { escapeHtml, truncateText } from "../interaction/formatter.js";
import type { TelegramAttachment } from "../session/types.js";
import type { MessageHandlerDeps } from "./message.js";
import { completeAgentProfile, showReadyCard } from "./setup.js";

export const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_PROMPT = 8;

export function registerDocumentHandler(bot: Bot, deps: MessageHandlerDeps): void {
  bot.on("message:document", async (ctx) => {
    const document = ctx.message.document;
    if (!document.file_name) {
      await ctx.reply("文件必须包含文件名。");
      return;
    }
    const isImage = document.mime_type?.startsWith("image/") ?? false;
    await receiveAttachment(ctx, deps, {
      name: document.file_name,
      kind: isImage ? "image" : "text",
      mimeType: document.mime_type,
      declaredSize: document.file_size
    });
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    await receiveAttachment(ctx, deps, {
      name: `telegram-photo-${ctx.message.message_id}.jpg`,
      kind: "image",
      mimeType: "image/jpeg",
      declaredSize: photo.file_size
    });
  });
}

type IncomingAttachment = {
  name: string;
  kind: "text" | "image";
  mimeType?: string;
  declaredSize?: number;
};

async function receiveAttachment(
  ctx: Context,
  deps: MessageHandlerDeps,
  incoming: IncomingAttachment
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const current = deps.sessionManager.getOrCreate(chatId);
  if (current.attachments.length >= MAX_ATTACHMENTS_PER_PROMPT) {
    await ctx.reply(`一次最多附加 ${MAX_ATTACHMENTS_PER_PROMPT} 个文件；请先发送问题使用现有附件。`);
    return;
  }

  const maxBytes = incoming.kind === "image" ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
  if (incoming.declaredSize && incoming.declaredSize > maxBytes) {
    await ctx.reply(formatSizeLimit(incoming.kind, maxBytes));
    return;
  }

  try {
    const buffer = await downloadTelegramFile(ctx, deps.config.token, maxBytes);
    let text = "";
    if (incoming.kind === "text") {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        await ctx.reply("该文件不是有效的 UTF-8 文本；二进制文件暂不能作为文本上下文。图片请直接以照片或 image/* 文件发送。");
        return;
      }
    }

    if (current.setupStep === "agent_profile") {
      if (incoming.kind === "image") {
        await ctx.reply("画像设置阶段请发送 UTF-8 文本文档；完成设置后即可发送图片。");
        return;
      }
      const next = await completeAgentProfile(ctx, deps, text, { showReady: false });
      if (next) await showReadyCard(ctx, deps, next);
      return;
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-telegram-"));
    const filePath = path.join(dir, path.basename(incoming.name));
    await fs.writeFile(filePath, buffer);
    const attachment: TelegramAttachment = {
      name: incoming.name,
      path: filePath,
      text: incoming.kind === "text" ? truncateText(text, 24000) : "",
      kind: incoming.kind,
      mimeType: incoming.mimeType,
      sizeBytes: buffer.length,
      createdAt: new Date().toISOString()
    };
    const session = deps.sessionManager.addAttachment(chatId, attachment);
    const label = incoming.kind === "image" ? "图片" : "文件";
    await ctx.reply(
      `已附加${label} <code>${escapeHtml(incoming.name)}</code>，将在下一条请求中使用（${session.attachments.length}/${MAX_ATTACHMENTS_PER_PROMPT}）。`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`附件处理失败：<code>${escapeHtml(message)}</code>`, { parse_mode: "HTML" });
  }
}

async function downloadTelegramFile(ctx: Context, token: string, maxBytes: number): Promise<Buffer> {
  const file = await ctx.getFile();
  if (!file.file_path) throw new Error("Telegram 未返回文件路径。");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）。`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(formatSizeLimit("file", maxBytes));
  return buffer;
}

function formatSizeLimit(kind: "text" | "image" | "file", maxBytes: number): string {
  const label = kind === "image" ? "图片" : kind === "text" ? "文本文件" : "文件";
  return `${label}过大，单个附件上限为 ${Math.round(maxBytes / 1024 / 1024)} MB。`;
}
