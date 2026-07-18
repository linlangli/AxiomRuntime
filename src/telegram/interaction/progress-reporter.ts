import type { Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { ProgressUpdate } from "../engine/types.js";
import { withTelegramNetworkRetry } from "../network-retry.js";
import { escapeHtml, Formatter, truncateText } from "./formatter.js";

export type ProgressReporterOptions = {
  silent?: boolean;
  throttleMs?: number;
};

type ProgressApi = Pick<Context["api"], "sendMessage" | "editMessageText" | "deleteMessage">;

const MAX_TIMELINE_ENTRIES = 8;

export class ProgressReporter {
  private messageId?: number;
  private pending?: ProgressUpdate;
  private timer?: NodeJS.Timeout;
  private finalized = false;
  private lastSignature = "";
  private toolCount = 0;
  private throttleMs: number;
  private readonly silent: boolean;
  private timeline: string[] = [];
  private lastTimelinePhase?: ProgressUpdate["phase"];
  private responsePreview = "";
  private startTime = Date.now();

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

  async replaceWithHtml(html: string, fallbackText: string, extra?: { reply_markup?: InlineKeyboardMarkup }): Promise<boolean> {
    if (this.silent || this.finalized) return false;
    this.clearPending();
    this.pending = undefined;
    if (!this.messageId) return false;
    try {
      await withTelegramNetworkRetry(() =>
        this.api.editMessageText(this.chatId, this.messageId!, html, { parse_mode: "HTML", ...extra })
      );
      this.finalized = true;
      return true;
    } catch (error) {
      this.handleTelegramError(error);
    }

    try {
      await withTelegramNetworkRetry(() =>
        this.api.editMessageText(this.chatId, this.messageId!, fallbackText || "(empty)", extra ? { ...extra } : undefined)
      );
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

    if (update.responseText?.trim()) {
      this.responsePreview = update.responseText.trim();
    }
    if (this.lastTimelinePhase !== update.phase || update.phase !== "writing") {
      const entry = Formatter.progress(update, { toolCount: this.toolCount });
      this.appendTimeline(entry);
      this.lastTimelinePhase = update.phase;
    }
    const preview = this.responsePreview
      ? `<blockquote>${escapeHtml(truncateText(this.responsePreview, 1200))}</blockquote>`
      : "";
    const text = [Formatter.progressTimeline(this.getDisplayEntries()), preview].filter(Boolean).join("\n\n");

    try {
      if (!this.messageId) {
        const message = await withTelegramNetworkRetry(() =>
          this.api.sendMessage(this.chatId, text, { parse_mode: "HTML" })
        );
        this.messageId = readMessageId(message);
      } else {
        await withTelegramNetworkRetry(() =>
          this.api.editMessageText(this.chatId, this.messageId!, text, { parse_mode: "HTML" })
        );
      }
      this.lastSignature = signature;
    } catch (error) {
      this.handleTelegramError(error);
    }
  }

  private appendTimeline(entry: string): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const last = this.timeline[this.timeline.length - 1];
    if (last && stripElapsed(last) === stripElapsed(entry)) {
      return;
    }
    this.timeline.push(`${entry} <i>${elapsed}s</i>`);
  }

  private getDisplayEntries(): string[] {
    if (this.timeline.length <= MAX_TIMELINE_ENTRIES) return this.timeline;
    const hidden = this.timeline.length - MAX_TIMELINE_ENTRIES;
    return [`<i>… +${hidden} more</i>`, ...this.timeline.slice(-MAX_TIMELINE_ENTRIES)];
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
    update.responseText ?? "",
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

function stripElapsed(entry: string): string {
  return entry.replace(/ <i>[\d.]+s<\/i>$/, "");
}
