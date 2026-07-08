import type { TelegramConfig } from "../config.js";
import type { TokenUsage } from "../../core/types.js";
import type { SessionStore } from "./store.js";
import type { TelegramAttachment, TelegramProviderUsage, TelegramSession } from "./types.js";

export type TelegramProviderUsageInput = {
  provider: string;
  model?: string;
  costUsd?: number;
  usage?: TokenUsage;
};

export class SessionManager {
  constructor(
    private store: SessionStore,
    private config: TelegramConfig
  ) {}

  getOrCreate(chatId: number, defaults: Partial<TelegramSession> = {}): TelegramSession {
    const existing = this.store.getActiveByChatId(chatId);
    if (existing) {
      this.store.touch(existing.id);
      return existing;
    }
    return this.store.create({
      chatId,
      engine: defaults.engine ?? this.config.defaultEngine,
      cwd: defaults.cwd ?? this.config.defaultCwd,
      permissionMode: defaults.permissionMode ?? this.config.defaultPermissionMode,
      approveAll: defaults.approveAll ?? false,
      setupStep: defaults.setupStep ?? "ready",
      status: defaults.status ?? "idle"
    });
  }

  startSetup(chatId: number): TelegramSession {
    this.store.closeByChatId(chatId);
    return this.store.create({
      chatId,
      engine: this.config.defaultEngine,
      cwd: this.config.defaultCwd,
      permissionMode: this.config.defaultPermissionMode,
      approveAll: false,
      setupStep: "workdir",
      status: "idle"
    });
  }

  getById(id: string): TelegramSession | null {
    return this.store.getById(id);
  }

  update(id: string, patch: Partial<TelegramSession>): TelegramSession {
    return this.store.update(id, patch);
  }

  newSession(chatId: number): TelegramSession {
    const current = this.store.getActiveByChatId(chatId);
    this.store.closeByChatId(chatId);
    return this.store.create({
      chatId,
      engine: current?.engine ?? this.config.defaultEngine,
      cwd: current?.cwd ?? this.config.defaultCwd,
      permissionMode: current?.permissionMode ?? this.config.defaultPermissionMode,
      approveAll: false,
      setupStep: current?.setupStep ?? "ready",
      status: "idle"
    });
  }

  clearConversation(chatId: number): TelegramSession {
    const current = this.getOrCreate(chatId);
    return this.store.update(current.id, {
      engineSessionId: null,
      approveAll: false,
      status: "idle",
      messageCount: 0,
      attachments: []
    });
  }

  recordProviderUsage(sessionId: string, input: TelegramProviderUsageInput): TelegramSession {
    const session = this.store.getById(sessionId);
    if (!session) {
      throw new Error(`Telegram session not found: ${sessionId}`);
    }
    const provider = input.provider.trim() || "unknown";
    const model = input.model?.trim() || "(unknown)";
    const hasCost = typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0;
    const nextUsage = upsertProviderUsage(session.providerUsage, {
      provider,
      model,
      costUsd: hasCost ? input.costUsd : undefined,
      usage: input.usage
    });
    return this.store.update(sessionId, { providerUsage: nextUsage });
  }

  resume(chatId: number, idPrefix?: string): TelegramSession | null {
    const sessions = this.getHistory(chatId, 20);
    const target = idPrefix
      ? sessions.find((session) => session.id.startsWith(idPrefix))
      : sessions.find((session) => session.status !== "closed") ?? sessions[0];
    if (!target) return null;
    this.store.closeByChatId(chatId);
    return this.store.update(target.id, { status: "idle", approveAll: false });
  }

  getHistory(chatId: number, limit = 10): TelegramSession[] {
    return this.store.listByChatId(chatId, limit);
  }

  getActiveSessions(limit = 100): TelegramSession[] {
    return this.store.listActiveByChat(limit);
  }

  addAttachment(chatId: number, attachment: TelegramAttachment): TelegramSession {
    const session = this.getOrCreate(chatId);
    return this.store.addAttachment(session.id, attachment);
  }

  clearAttachments(sessionId: string): TelegramSession {
    return this.store.clearAttachments(sessionId);
  }

  rememberWorkdir(chatId: number, cwd: string): void {
    this.store.rememberWorkdir(chatId, cwd);
  }

  getWorkdirs(chatId: number, limit = 8): string[] {
    return this.store.listWorkdirs(chatId, limit);
  }

  cleanupExpired(): number {
    return this.store.deleteExpired(this.config.sessionTimeoutHours);
  }
}

export type { TelegramAttachment, TelegramSession } from "./types.js";

function upsertProviderUsage(
  usage: TelegramProviderUsage[],
  input: TelegramProviderUsageInput
): TelegramProviderUsage[] {
  const now = new Date().toISOString();
  const index = usage.findIndex((item) => item.provider === input.provider);
  const current = index >= 0 ? usage[index] : null;
  const hasCost = typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0;
  const next: TelegramProviderUsage = {
    provider: input.provider,
    model: input.model || current?.model || "(unknown)",
    requestCount: (current?.requestCount ?? 0) + 1,
    costUsd: (current?.costUsd ?? 0) + (hasCost ? input.costUsd! : 0),
    unknownCostCount: (current?.unknownCostCount ?? 0) + (hasCost ? 0 : 1),
    inputTokens: (current?.inputTokens ?? 0) + (input.usage?.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (input.usage?.outputTokens ?? 0),
    totalTokens: (current?.totalTokens ?? 0) + (input.usage?.totalTokens ?? 0),
    cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) + (input.usage?.cacheReadInputTokens ?? 0),
    updatedAt: now
  };
  if (index < 0) return [...usage, next];
  return usage.map((item, itemIndex) => itemIndex === index ? next : item);
}
