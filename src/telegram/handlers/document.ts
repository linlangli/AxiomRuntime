import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import type { TelegramConfig } from "../config.js";
import { escapeHtml, truncateText } from "../interaction/formatter.js";
import type { SessionManager } from "../session/manager.js";

const MAX_ATTACHMENT_BYTES = 512 * 1024;

export function registerDocumentHandler(bot: Bot, deps: {
  sessionManager: SessionManager;
  config: TelegramConfig;
}): void {
  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;
    const document = ctx.message.document;
    if (!document.file_name) {
      await ctx.reply("Document must have a filename.");
      return;
    }
    if (document.file_size && document.file_size > MAX_ATTACHMENT_BYTES) {
      await ctx.reply(`File is too large. Max ${(MAX_ATTACHMENT_BYTES / 1024).toFixed(0)} KB.`);
      return;
    }

    try {
      const file = await ctx.getFile();
      if (!file.file_path) {
        await ctx.reply("Failed to resolve Telegram file path.");
        return;
      }
      const response = await fetch(`https://api.telegram.org/file/bot${deps.config.token}/${file.file_path}`);
      if (!response.ok) {
        await ctx.reply(`Download failed: ${response.status}`);
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        await ctx.reply(`File is too large. Max ${(MAX_ATTACHMENT_BYTES / 1024).toFixed(0)} KB.`);
        return;
      }
      const text = buffer.toString("utf8");
      if (text.includes("\u0000")) {
        await ctx.reply("Binary files are not supported as prompt context yet.");
        return;
      }
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-telegram-"));
      const filePath = path.join(dir, path.basename(document.file_name));
      await fs.writeFile(filePath, buffer);
      const session = deps.sessionManager.addAttachment(chatId, {
        name: document.file_name,
        path: filePath,
        text: truncateText(text, 12000),
        createdAt: new Date().toISOString()
      });
      await ctx.reply(
        `Attached <code>${escapeHtml(document.file_name)}</code>. It will be included in the next prompt. Attachments: ${session.attachments.length}`,
        { parse_mode: "HTML" }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Attachment failed: <code>${escapeHtml(message)}</code>`, { parse_mode: "HTML" });
    }
  });
}
