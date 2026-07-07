import type { TelegramConfig } from "../config.js";
import type { SessionStore } from "./store.js";
import type { TelegramAttachment, TelegramSession } from "./types.js";

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
