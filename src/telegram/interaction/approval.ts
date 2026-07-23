import type { Bot } from "grammy";
import type { PermissionRequest } from "../engine/types.js";
import { escapeHtml, truncateText } from "./formatter.js";
import { buildApprovalKeyboard } from "./keyboards.js";

type PendingApproval = {
  id: string;
  chatId: number;
  messageId?: number;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
};

const TIMEOUT_MS = 5 * 60 * 1000;
const ALWAYS_CONFIRM_PATTERNS = [
  /rm\s+(-rf?|--recursive)/i,
  /git\s+push\s+.*--force/i,
  /git\s+reset\s+--hard/i,
  /DROP\s+(TABLE|DATABASE)/i,
  /sudo\s+/i,
  /chmod\s+777/i,
  />\s*\/dev\//i
];

export class ApprovalManager {
  private pending = new Map<string, PendingApproval>();

  constructor(private bot: Bot) {}

  async request(chatId: number, req: PermissionRequest): Promise<boolean> {
    const message = await this.bot.api.sendMessage(chatId, formatPermissionMessage(req), {
      parse_mode: "HTML",
      reply_markup: buildApprovalKeyboard(req.id)
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(req.id);
        resolve(false);
        void this.markExpired(chatId, message.message_id);
      }, TIMEOUT_MS);

      this.pending.set(req.id, {
        id: req.id,
        chatId,
        messageId: message.message_id,
        resolve,
        timeout
      });
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.pending.delete(id);
    entry.resolve(approved);
    void this.markResolved(entry, approved);
    return true;
  }

  resolveAll(chatId: number, approved: boolean): number {
    let count = 0;
    for (const [id, entry] of this.pending) {
      if (entry.chatId === chatId) {
        clearTimeout(entry.timeout);
        this.pending.delete(id);
        entry.resolve(approved);
        void this.markResolved(entry, approved);
        count += 1;
      }
    }
    return count;
  }

  hasPending(chatId: number): boolean {
    return [...this.pending.values()].some((entry) => entry.chatId === chatId);
  }

  private async markResolved(entry: PendingApproval, approved: boolean): Promise<void> {
    if (!entry.messageId) return;
    try {
      await this.bot.api.editMessageReplyMarkup(entry.chatId, entry.messageId, {
        reply_markup: undefined
      });
      await this.bot.api.sendMessage(entry.chatId, approved ? "Permission allowed." : "Permission denied.");
    } catch {
      // Telegram messages may be gone or no longer editable.
    }
  }

  private async markExpired(chatId: number, messageId: number): Promise<void> {
    try {
      await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: undefined });
      await this.bot.api.sendMessage(chatId, "Permission request timed out.");
    } catch {
      // Best-effort UI cleanup.
    }
  }
}

export function requiresDangerousConfirmation(command: string): boolean {
  return ALWAYS_CONFIRM_PATTERNS.some((pattern) => pattern.test(command));
}

export function formatPermissionMessage(req: PermissionRequest): string {
  const lines = [
    "<b>Permission request</b>",
    "",
    `tool: <code>${escapeHtml(req.tool)}</code>`
  ];

  if (req.command) {
    lines.push("command:", `<pre>${escapeHtml(truncateText(req.command, 300))}</pre>`);
  }
  if (req.filePath) {
    lines.push(`file: <code>${escapeHtml(req.filePath)}</code>`);
  }
  if (req.description) {
    lines.push("", escapeHtml(truncateText(req.description, 300)));
  }
  lines.push("", "<i>Automatically denied after 5 minutes.</i>");
  return lines.join("\n");
}
