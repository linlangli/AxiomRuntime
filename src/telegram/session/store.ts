import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  CustomCommand,
  TelegramAttachment,
  TelegramConversationTurn,
  TelegramPinnedTurn,
  TelegramProviderUsage,
  TelegramSession,
  TelegramSessionCreateInput,
  TelegramSetupStep
} from "./types.js";

type SessionRow = {
  id: string;
  chat_id: number;
  engine: string;
  engine_session_id: string | null;
  bot_context_fingerprint: string | null;
  cwd: string;
  permission_mode: string;
  approve_all: number;
  setup_step: string;
  status: string;
  message_count: number;
  attachments_json: string;
  conversation_json: string;
  pinned_turns_json: string | null;
  provider_usage_json: string;
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
      botContextFingerprint: null,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      approveAll: input.approveAll ?? false,
      setupStep: input.setupStep ?? "ready",
      status: input.status ?? "idle",
      messageCount: 0,
      attachments: [],
      conversation: [],
      pinnedTurns: [],
      providerUsage: [],
      createdAt: now,
      lastActiveAt: now
    };
    this.db.prepare(
      `insert into sessions (
        id, chat_id, engine, engine_session_id, bot_context_fingerprint, cwd, permission_mode, approve_all, setup_step,
        status, message_count, attachments_json, conversation_json, pinned_turns_json, provider_usage_json, created_at, last_active_at
      ) values (
        @id, @chatId, @engine, @engineSessionId, @botContextFingerprint, @cwd, @permissionMode, @approveAll, @setupStep,
        @status, @messageCount, @attachmentsJson, @conversationJson, @pinnedTurnsJson, @providerUsageJson, @createdAt, @lastActiveAt
      )`
    ).run({
      ...session,
      approveAll: session.approveAll ? 1 : 0,
      setupStep: session.setupStep,
      attachmentsJson: JSON.stringify(session.attachments),
      conversationJson: JSON.stringify(session.conversation),
      pinnedTurnsJson: JSON.stringify(session.pinnedTurns),
      providerUsageJson: JSON.stringify(session.providerUsage)
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

  listActiveByChat(limit = 100): TelegramSession[] {
    const rows = this.db.prepare(
      "select * from sessions where status != 'closed' order by chat_id asc, last_active_at desc limit ?"
    ).all(limit * 5) as SessionRow[];
    const seen = new Set<number>();
    const sessions: TelegramSession[] = [];
    for (const row of rows) {
      if (seen.has(row.chat_id)) continue;
      seen.add(row.chat_id);
      sessions.push(rowToSession(row));
      if (sessions.length >= limit) break;
    }
    return sessions;
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
      conversation: patch.conversation ?? current.conversation,
      pinnedTurns: patch.pinnedTurns ?? current.pinnedTurns,
      providerUsage: patch.providerUsage ?? current.providerUsage,
      lastActiveAt: patch.lastActiveAt ?? new Date().toISOString()
    };
    this.db.prepare(
      `update sessions set
        engine = @engine,
        engine_session_id = @engineSessionId,
        bot_context_fingerprint = @botContextFingerprint,
        cwd = @cwd,
        permission_mode = @permissionMode,
        approve_all = @approveAll,
        setup_step = @setupStep,
        status = @status,
        message_count = @messageCount,
        attachments_json = @attachmentsJson,
        conversation_json = @conversationJson,
        pinned_turns_json = @pinnedTurnsJson,
        provider_usage_json = @providerUsageJson,
        last_active_at = @lastActiveAt
       where id = @id`
    ).run({
      id,
      engine: next.engine,
      engineSessionId: next.engineSessionId,
      botContextFingerprint: next.botContextFingerprint,
      cwd: next.cwd,
      permissionMode: next.permissionMode,
      approveAll: next.approveAll ? 1 : 0,
      setupStep: next.setupStep,
      status: next.status,
      messageCount: next.messageCount,
      attachmentsJson: JSON.stringify(next.attachments),
      conversationJson: JSON.stringify(next.conversation),
      pinnedTurnsJson: JSON.stringify(next.pinnedTurns),
      providerUsageJson: JSON.stringify(next.providerUsage),
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

  resetRunningToIdle(): number {
    const result = this.db.prepare(
      "update sessions set status = 'idle' where status in ('running', 'waiting_approval')"
    ).run();
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
        bot_context_fingerprint text,
        cwd text not null,
        permission_mode text not null,
        approve_all integer not null default 0,
        setup_step text not null default 'ready',
        status text not null,
        message_count integer not null default 0,
        attachments_json text not null default '[]',
        conversation_json text not null default '[]',
        provider_usage_json text not null default '[]',
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
    this.ensureColumn("sessions", "provider_usage_json", "provider_usage_json text not null default '[]'");
    this.ensureColumn("sessions", "bot_context_fingerprint", "bot_context_fingerprint text");
    this.ensureColumn("sessions", "conversation_json", "conversation_json text not null default '[]'");
    this.ensureColumn("sessions", "pinned_turns_json", "pinned_turns_json text not null default '[]'");
    this.db.exec(`
      create table if not exists custom_commands (
        chat_id integer not null,
        cwd text not null,
        name text not null,
        params_json text not null default '[]',
        template text not null,
        description text not null,
        created_at text not null,
        primary key (chat_id, cwd, name)
      );
    `);
  }

  addCustomCommand(chatId: number, cwd: string, cmd: CustomCommand): void {
    this.db.prepare(
      `insert or replace into custom_commands (chat_id, cwd, name, params_json, template, description, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`
    ).run(chatId, cwd, cmd.name, JSON.stringify(cmd.params), cmd.template, cmd.description, new Date().toISOString());
  }

  listCustomCommands(chatId: number, cwd: string): CustomCommand[] {
    const rows = this.db.prepare(
      "select name, params_json, template, description from custom_commands where chat_id = ? and cwd = ? order by created_at"
    ).all(chatId, cwd) as Array<{ name: string; params_json: string; template: string; description: string }>;
    return rows.map((r) => ({
      name: r.name,
      params: JSON.parse(r.params_json),
      template: r.template,
      description: r.description
    }));
  }

  deleteCustomCommand(chatId: number, cwd: string, name: string): boolean {
    const result = this.db.prepare(
      "delete from custom_commands where chat_id = ? and cwd = ? and name = ?"
    ).run(chatId, cwd, name);
    return result.changes > 0;
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
    botContextFingerprint: row.bot_context_fingerprint ?? null,
    cwd: row.cwd,
    permissionMode: row.permission_mode === "readOnly" || row.permission_mode === "acceptEdits" || row.permission_mode === "bypassPermissions" ? row.permission_mode : "default",
    approveAll: row.approve_all === 1,
    setupStep: normalizeSetupStep(row.setup_step),
    status: row.status === "running" || row.status === "waiting_approval" || row.status === "closed" ? row.status : "idle",
    messageCount: row.message_count,
    attachments: parseAttachments(row.attachments_json),
    conversation: parseConversation(row.conversation_json),
    pinnedTurns: parsePinnedTurns(row.pinned_turns_json),
    providerUsage: parseProviderUsage(row.provider_usage_json),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at
  };
}

function normalizeSetupStep(value: string): TelegramSetupStep {
  if (
    value === "model"
    || value === "workdir"
    || value === "custom_workdir"
    || value === "edit_custom_workdir"
    || value === "usage_price_input"
    || value === "remember_global"
    || value === "remember_bot"
    || value === "remember_auto"
    || value === "memory_promote"
    || value === "cli"
    || value === "agent_profile"
    || value === "command_name"
    || value === "command_template"
    || value === "ready"
  ) return value;
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

function parseConversation(value: string): TelegramConversationTurn[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => isConversationTurn(item) ? [item] : []);
  } catch {
    return [];
  }
}

function parsePinnedTurns(value: string | null): TelegramPinnedTurn[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is TelegramPinnedTurn => {
      const t = item as TelegramPinnedTurn;
      return Boolean(t && typeof t.messageId === "number" && typeof t.user === "string" && typeof t.assistant === "string");
    });
  } catch {
    return [];
  }
}

function parseProviderUsage(value: string): TelegramProviderUsage[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!isProviderUsage(item)) return [];
      return [{
        provider: item.provider,
        model: item.model,
        requestCount: item.requestCount,
        costUsd: item.costUsd,
        unknownCostCount: item.unknownCostCount,
        inputTokens: readNonNegativeNumber(item.inputTokens),
        outputTokens: readNonNegativeNumber(item.outputTokens),
        totalTokens: readNonNegativeNumber(item.totalTokens),
        cacheReadInputTokens: readNonNegativeNumber(item.cacheReadInputTokens),
        updatedAt: item.updatedAt
      }];
    });
  } catch {
    return [];
  }
}

function isAttachment(value: unknown): value is TelegramAttachment {
  const item = value as TelegramAttachment;
  return Boolean(item && typeof item.name === "string" && typeof item.path === "string" && typeof item.text === "string");
}

function isConversationTurn(value: unknown): value is TelegramConversationTurn {
  const item = value as TelegramConversationTurn;
  return Boolean(
    item
      && typeof item.user === "string"
      && typeof item.assistant === "string"
      && typeof item.createdAt === "string"
  );
}

function isProviderUsage(value: unknown): value is TelegramProviderUsage {
  const item = value as TelegramProviderUsage;
  return Boolean(
    item
      && typeof item.provider === "string"
      && typeof item.model === "string"
      && Number.isFinite(item.requestCount)
      && Number.isFinite(item.costUsd)
      && Number.isFinite(item.unknownCostCount)
      && typeof item.updatedAt === "string"
  );
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
