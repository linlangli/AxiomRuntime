import fs from "node:fs";
import type { TelegramConfig } from "../config.js";
import type { TokenUsage } from "../../core/types.js";
import type { SessionStore } from "./store.js";
import type { CustomCommand, TelegramAttachment, TelegramConversationTurn, TelegramPinnedTurn, TelegramProviderUsage, TelegramSession } from "./types.js";

export type TelegramProviderUsageInput = {
  provider: string;
  model?: string;
  costUsd?: number;
  usage?: TokenUsage;
};

export type TelegramConversationTurnInput = {
  user: string;
  assistant: string;
};

const MAX_CONVERSATION_TURNS = 12;
const MAX_CONVERSATION_USER_CHARS = 1000;
const MAX_CONVERSATION_ASSISTANT_CHARS = 1600;
const MAX_PINNED_TURNS = 3;

export class SessionManager {
  private chatQueues = new Map<number, Promise<void>>();

  constructor(
    private store: SessionStore,
    private config: TelegramConfig
  ) {}

  async runExclusive<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    const waitForPrevious = previous.catch(() => undefined);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = waitForPrevious.then(() => current);
    this.chatQueues.set(chatId, next);

    await waitForPrevious;
    try {
      return await task();
    } finally {
      release();
      if (this.chatQueues.get(chatId) === next) {
        this.chatQueues.delete(chatId);
      }
    }
  }

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
      setupStep: "model",
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
      botContextFingerprint: null,
      approveAll: false,
      status: "idle",
      messageCount: 0,
      attachments: [],
      conversation: []
    });
  }

  pinTurn(chatId: number, messageId: number, turn: { user: string; assistant: string }): TelegramSession {
    const session = this.getOrCreate(chatId);
    const existing = session.pinnedTurns.find((p) => p.messageId === messageId);
    if (existing) return session;
    const pinned: TelegramPinnedTurn = {
      messageId,
      user: truncateConversationText(turn.user, MAX_CONVERSATION_USER_CHARS),
      assistant: truncateConversationText(turn.assistant, MAX_CONVERSATION_ASSISTANT_CHARS),
      pinnedAt: new Date().toISOString()
    };
    const next = [...session.pinnedTurns, pinned].slice(-MAX_PINNED_TURNS);
    return this.store.update(session.id, { pinnedTurns: next });
  }

  unpinTurn(chatId: number, messageId: number): TelegramSession {
    const session = this.getOrCreate(chatId);
    const next = session.pinnedTurns.filter((p) => p.messageId !== messageId);
    if (next.length === session.pinnedTurns.length) return session;
    return this.store.update(session.id, { pinnedTurns: next });
  }

  appendConversationTurn(sessionId: string, input: TelegramConversationTurnInput): TelegramSession {
    const session = this.store.getById(sessionId);
    if (!session) {
      throw new Error(`Telegram session not found: ${sessionId}`);
    }
    const turn: TelegramConversationTurn = {
      user: truncateConversationText(input.user, MAX_CONVERSATION_USER_CHARS),
      assistant: truncateConversationText(input.assistant, MAX_CONVERSATION_ASSISTANT_CHARS),
      createdAt: new Date().toISOString()
    };
    return this.store.update(sessionId, {
      conversation: [...session.conversation, turn].slice(-MAX_CONVERSATION_TURNS)
    });
  }

  prepareEditedPrompt(chatId: number, previousPrompt: string): TelegramSession {
    const session = this.getOrCreate(chatId);
    const conversation = [...session.conversation];
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
      if (conversation[index]?.user === previousPrompt) {
        conversation.splice(index, 1);
        break;
      }
    }
    return this.store.update(session.id, {
      engineSessionId: null,
      conversation
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
    return this.store.listWorkdirs(chatId, limit).filter((p) => fs.existsSync(p));
  }

  addCustomCommand(chatId: number, cwd: string, cmd: CustomCommand): void {
    this.store.addCustomCommand(chatId, cwd, cmd);
  }

  listCustomCommands(chatId: number, cwd: string): CustomCommand[] {
    return this.store.listCustomCommands(chatId, cwd);
  }

  deleteCustomCommand(chatId: number, cwd: string, name: string): boolean {
    return this.store.deleteCustomCommand(chatId, cwd, name);
  }

  cleanupExpired(): number {
    return this.store.deleteExpired(this.config.sessionTimeoutHours);
  }

  resetOrphanSessions(): number {
    return this.store.resetRunningToIdle();
  }
}

export type { TelegramAttachment, TelegramSession } from "./types.js";

function truncateConversationText(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

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
