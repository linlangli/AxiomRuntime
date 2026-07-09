import type { Context } from "grammy";
import type { ProgressUpdate } from "../engine/types.js";
import { Formatter } from "./formatter.js";

export type ProgressReporterOptions = {
  silent?: boolean;
  throttleMs?: number;
};

type ProgressApi = Pick<Context["api"], "sendMessage" | "editMessageText" | "deleteMessage">;

export class ProgressReporter {
  private messageId?: number;
  private pending?: ProgressUpdate;
  private timer?: NodeJS.Timeout;
  private finalized = false;
  private lastSignature = "";
  private toolCount = 0;
  private throttleMs: number;
  private readonly silent: boolean;

  constructor(
    private readonly api: ProgressApi,
    private readonly chatId: number,
    options: ProgressReporterOptions = {}
  ) {
    this.silent = options.silent ?? false;
    this.throttleMs = options.throttleMs ?? 1500;
  }

  async update(update: ProgressUpdate): Promise<void> {
    if (this.silent || this.finalized || update.phase === "done") return;
    if (update.phase === "tool_calling") this.toolCount += 1;
    this.pending = update;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.throttleMs);
    this.timer.unref?.();
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.clearPending();
    this.pending = undefined;
    if (!this.messageId || this.silent) return;
    try {
      await this.api.deleteMessage(this.chatId, this.messageId);
    } catch {
      // Progress messages are best-effort and must not affect task completion.
    }
  }

  async replaceWithHtml(html: string, fallbackText: string): Promise<boolean> {
    if (this.silent || this.finalized) return false;
    this.clearPending();
    this.pending = undefined;
    if (!this.messageId) return false;
    try {
      await this.api.editMessageText(this.chatId, this.messageId, html, { parse_mode: "HTML" });
      this.finalized = true;
      return true;
    } catch (error) {
      this.handleTelegramError(error);
    }

    try {
      await this.api.editMessageText(this.chatId, this.messageId, fallbackText || "(empty)");
      this.finalized = true;
      return true;
    } catch (error) {
      this.handleTelegramError(error);
      return false;
    }
  }

  private async flush(): Promise<void> {
    if (this.silent || this.finalized || !this.pending) return;
    const update = this.pending;
    this.pending = undefined;
    const signature = buildProgressSignature(update, this.toolCount);
    if (signature === this.lastSignature) return;
    const text = Formatter.progress(update, {
      toolCount: this.toolCount
    });
    try {
      if (!this.messageId) {
        const message = await this.api.sendMessage(this.chatId, text, { parse_mode: "HTML" });
        this.messageId = readMessageId(message);
      } else {
        await this.api.editMessageText(this.chatId, this.messageId, text, { parse_mode: "HTML" });
      }
      this.lastSignature = signature;
    } catch (error) {
      this.handleTelegramError(error);
    }
  }

  private handleTelegramError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (/429|Too Many Requests/i.test(message)) {
      this.throttleMs = Math.min(this.throttleMs * 2, 5000);
    }
  }

  private clearPending(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function buildProgressSignature(update: ProgressUpdate, toolCount: number): string {
  return [
    update.phase,
    update.message ?? "",
    update.tool ?? "",
    update.toolKind ?? "",
    update.mcpServer ?? "",
    update.phase === "tool_calling" ? toolCount : ""
  ].join("\0");
}

function readMessageId(value: unknown): number | undefined {
  if (value && typeof value === "object" && "message_id" in value) {
    const id = Number((value as { message_id?: unknown }).message_id);
    return Number.isFinite(id) ? id : undefined;
  }
  return undefined;
}
