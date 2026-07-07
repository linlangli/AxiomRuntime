import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { TelegramAttachment, TelegramSession, TelegramSessionCreateInput, TelegramSetupStep } from "./types.js";

type SessionRow = {
  id: string;
  chat_id: number;
  engine: string;
  engine_session_id: string | null;
  cwd: string;
  permission_mode: string;
  approve_all: number;
  setup_step: string;
  status: string;
  message_count: number;
  attachments_json: string;
  created_at: string;
  last_active_at: string;
};

export class SessionStore {
  private db: Database.Database;

  constructor(private dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  create(input: TelegramSessionCreateInput): TelegramSession {
    const now = new Date().toISOString();
    const session: TelegramSession = {
      id: randomUUID(),
      chatId: input.chatId,
      engine: input.engine,
      engineSessionId: null,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      approveAll: input.approveAll ?? false,
      setupStep: input.setupStep ?? "ready",
      status: input.status ?? "idle",
      messageCount: 0,
      attachments: [],
      createdAt: now,
      lastActiveAt: now
    };
    this.db.prepare(
      `insert into sessions (
        id, chat_id, engine, engine_session_id, cwd, permission_mode, approve_all, setup_step,
        status, message_count, attachments_json, created_at, last_active_at
      ) values (
        @id, @chatId, @engine, @engineSessionId, @cwd, @permissionMode, @approveAll, @setupStep,
        @status, @messageCount, @attachmentsJson, @createdAt, @lastActiveAt
      )`
    ).run({
      ...session,
      approveAll: session.approveAll ? 1 : 0,
      setupStep: session.setupStep,
      attachmentsJson: JSON.stringify(session.attachments)
    });
    return session;
  }

  getById(id: string): TelegramSession | null {
    const row = this.db.prepare("select * from sessions where id = ?").get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  getActiveByChatId(chatId: number): TelegramSession | null {
    const row = this.db.prepare(
      "select * from sessions where chat_id = ? and status != 'closed' order by last_active_at desc limit 1"
    ).get(chatId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  listByChatId(chatId: number, limit = 10): TelegramSession[] {
    const rows = this.db.prepare(
      "select * from sessions where chat_id = ? order by last_active_at desc limit ?"
    ).all(chatId, limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  update(id: string, patch: Partial<TelegramSession>): TelegramSession {
    const current = this.getById(id);
    if (!current) {
      throw new Error(`Telegram session not found: ${id}`);
    }
    const next: TelegramSession = {
      ...current,
      ...patch,
      attachments: patch.attachments ?? current.attachments,
      lastActiveAt: patch.lastActiveAt ?? new Date().toISOString()
    };
    this.db.prepare(
      `update sessions set
        engine = @engine,
        engine_session_id = @engineSessionId,
        cwd = @cwd,
        permission_mode = @permissionMode,
        approve_all = @approveAll,
        setup_step = @setupStep,
        status = @status,
        message_count = @messageCount,
        attachments_json = @attachmentsJson,
        last_active_at = @lastActiveAt
       where id = @id`
    ).run({
      id,
      engine: next.engine,
      engineSessionId: next.engineSessionId,
      cwd: next.cwd,
      permissionMode: next.permissionMode,
      approveAll: next.approveAll ? 1 : 0,
      setupStep: next.setupStep,
      status: next.status,
      messageCount: next.messageCount,
      attachmentsJson: JSON.stringify(next.attachments),
      lastActiveAt: next.lastActiveAt
    });
    return next;
  }

  closeByChatId(chatId: number): void {
    this.db.prepare("update sessions set status = 'closed', last_active_at = ? where chat_id = ? and status != 'closed'")
      .run(new Date().toISOString(), chatId);
  }

  rememberWorkdir(chatId: number, cwd: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `insert into workdirs (chat_id, cwd, last_used_at)
       values (?, ?, ?)
       on conflict(chat_id, cwd) do update set last_used_at = excluded.last_used_at`
    ).run(chatId, cwd, now);
  }

  listWorkdirs(chatId: number, limit = 8): string[] {
    const rows = this.db.prepare(
      "select cwd from workdirs where chat_id = ? order by last_used_at desc limit ?"
    ).all(chatId, limit) as Array<{ cwd: string }>;
    return rows.map((row) => row.cwd);
  }

  touch(id: string): void {
    this.db.prepare("update sessions set last_active_at = ? where id = ?").run(new Date().toISOString(), id);
  }

  deleteExpired(timeoutHours: number): number {
    const cutoff = new Date(Date.now() - timeoutHours * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare("delete from sessions where last_active_at < ?").run(cutoff);
    return result.changes;
  }

  addAttachment(sessionId: string, attachment: TelegramAttachment): TelegramSession {
    const session = this.getById(sessionId);
    if (!session) {
      throw new Error(`Telegram session not found: ${sessionId}`);
    }
    return this.update(sessionId, {
      attachments: [...session.attachments, attachment].slice(-5)
    });
  }

  clearAttachments(sessionId: string): TelegramSession {
    return this.update(sessionId, { attachments: [] });
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists sessions (
        id text primary key,
        chat_id integer not null,
        engine text not null,
        engine_session_id text,
        cwd text not null,
        permission_mode text not null,
        approve_all integer not null default 0,
        setup_step text not null default 'ready',
        status text not null,
        message_count integer not null default 0,
        attachments_json text not null default '[]',
        created_at text not null,
        last_active_at text not null
      );
      create index if not exists idx_sessions_chat_active on sessions(chat_id, status, last_active_at);
      create table if not exists workdirs (
        chat_id integer not null,
        cwd text not null,
        last_used_at text not null,
        primary key (chat_id, cwd)
      );
      create index if not exists idx_workdirs_chat_last_used on workdirs(chat_id, last_used_at);
    `);
    this.ensureColumn("sessions", "setup_step", "setup_step text not null default 'ready'");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`alter table ${table} add column ${definition}`);
    }
  }
}

function rowToSession(row: SessionRow): TelegramSession {
  return {
    id: row.id,
    chatId: row.chat_id,
    engine: row.engine === "codex" ? "codex" : "claude",
    engineSessionId: row.engine_session_id,
    cwd: row.cwd,
    permissionMode: row.permission_mode === "acceptEdits" || row.permission_mode === "bypassPermissions" ? row.permission_mode : "default",
    approveAll: row.approve_all === 1,
    setupStep: normalizeSetupStep(row.setup_step),
    status: row.status === "running" || row.status === "waiting_approval" || row.status === "closed" ? row.status : "idle",
    messageCount: row.message_count,
    attachments: parseAttachments(row.attachments_json),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at
  };
}

function normalizeSetupStep(value: string): TelegramSetupStep {
  if (value === "workdir" || value === "custom_workdir" || value === "cli" || value === "ready") return value;
  return "ready";
}

function parseAttachments(value: string): TelegramAttachment[] {
  try {
    const parsed = JSON.parse(value) as TelegramAttachment[];
    return Array.isArray(parsed) ? parsed.filter(isAttachment) : [];
  } catch {
    return [];
  }
}

function isAttachment(value: unknown): value is TelegramAttachment {
  const item = value as TelegramAttachment;
  return Boolean(item && typeof item.name === "string" && typeof item.path === "string" && typeof item.text === "string");
}
