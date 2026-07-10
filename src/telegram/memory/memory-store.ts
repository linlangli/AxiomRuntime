import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getMemoryDbPath } from "../../core/config/paths.js";
import type { MemoryCategory, MemoryDuration, MemoryEntry, MemorySaveInput, MemoryScope } from "./types.js";

type MemoryRow = {
  id: number;
  chatId: string;
  scope: MemoryScope;
  botId: string | null;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string;
  priority: number;
  duration: MemoryDuration;
  encrypted: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type StoreSaveInput = Required<Pick<MemorySaveInput, "scope" | "category" | "title" | "content" | "tags" | "priority" | "duration" | "encrypted">> & {
  chatId: string;
  botId: string | null;
  expiresAt: number | null;
};

export class MemoryStore {
  private db: Database.Database;

  constructor(private readonly dbPath = getMemoryDbPath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  getPath(): string {
    return this.dbPath;
  }

  save(input: StoreSaveInput): MemoryEntry {
    const now = Date.now();
    const result = this.db.prepare(
      `insert into memories (
        chatId, scope, botId, category, title, content, tags, priority, duration,
        encrypted, expiresAt, createdAt, updatedAt
      ) values (
        @chatId, @scope, @botId, @category, @title, @content, @tagsJson, @priority, @duration,
        @encryptedValue, @expiresAt, @now, @now
      )`
    ).run({
      ...input,
      tagsJson: JSON.stringify(input.tags),
      encryptedValue: input.encrypted ? 1 : 0,
      now
    });
    return this.getById(Number(result.lastInsertRowid))!;
  }

  upsertSingleton(input: StoreSaveInput): MemoryEntry {
    const current = this.getSingleton(input.chatId, input.scope, input.botId, input.category, input.title);
    if (current) {
      const now = Date.now();
      this.db.prepare(
        `update memories set
          content = @content,
          tags = @tagsJson,
          priority = @priority,
          duration = @duration,
          encrypted = @encryptedValue,
          expiresAt = @expiresAt,
          updatedAt = @now
         where id = @id`
      ).run({
        id: current.id,
        content: input.content,
        tagsJson: JSON.stringify(input.tags),
        priority: input.priority,
        duration: input.duration,
        encryptedValue: input.encrypted ? 1 : 0,
        expiresAt: input.expiresAt,
        now
      });
      return this.getById(current.id)!;
    }
    const now = Date.now();
    this.db.prepare(
      `insert into memories (
        chatId, scope, botId, category, title, content, tags, priority, duration,
        encrypted, expiresAt, createdAt, updatedAt
      ) values (
        @chatId, @scope, @botId, @category, @title, @content, @tagsJson, @priority, @duration,
        @encryptedValue, @expiresAt, @now, @now
      )`
    ).run({
      ...input,
      tagsJson: JSON.stringify(input.tags),
      encryptedValue: input.encrypted ? 1 : 0,
      now
    });
    return this.getSingleton(input.chatId, input.scope, input.botId, input.category, input.title)!;
  }

  getById(id: number): MemoryEntry | null {
    const row = this.db.prepare("select * from memories where id = ?").get(id) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  getSingleton(
    chatId: string,
    scope: MemoryScope,
    botId: string | null,
    category: MemoryCategory,
    title: string
  ): MemoryEntry | null {
    const row = this.db.prepare(
      `select * from memories
       where chatId = ? and scope = ? and botId is ? and category = ? and title = ?
       limit 1`
    ).get(chatId, scope, botId, category, title) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  getProfile(chatId: string): MemoryEntry | null {
    const row = this.db.prepare(
      "select * from memories where chatId = ? and scope = 'global' and category = 'profile' order by updatedAt desc limit 1"
    ).get(chatId) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  getPersona(chatId: string, botId: string): MemoryEntry | null {
    const row = this.db.prepare(
      "select * from memories where chatId = ? and scope = 'bot' and botId = ? and category = 'persona' order by updatedAt desc limit 1"
    ).get(chatId, botId) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  listVisible(input: { chatId: string; botId: string; query?: string; limit?: number }): MemoryEntry[] {
    const now = Date.now();
    const params: Record<string, unknown> = {
      chatId: input.chatId,
      botId: input.botId,
      now,
      limit: input.limit ?? 100
    };
    const query = input.query?.trim().toLowerCase();
    const searchClause = query
      ? "and (lower(title) like @query or lower(content) like @query or lower(tags) like @query)"
      : "";
    if (query) params.query = `%${query}%`;
    const rows = this.db.prepare(
      `select * from memories
       where ${visibilityClause()} and (expiresAt is null or expiresAt > @now)
       ${searchClause}
       order by priority desc, updatedAt desc, id desc
       limit @limit`
    ).all(params) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  deleteVisibleById(chatId: string, botId: string, id: number): number {
    const result = this.db.prepare(
      `delete from memories
       where id = @id and ${visibilityClause()}`
    ).run({ chatId, botId, id });
    return result.changes;
  }

  deleteVisibleByKeyword(chatId: string, botId: string, keyword: string): number {
    if (keyword.trim().length < 2) return 0;
    const query = `%${keyword.trim().toLowerCase()}%`;
    const result = this.db.prepare(
      `delete from memories
       where ${visibilityClause()}
       and (lower(title) like @query or lower(content) like @query or lower(tags) like @query)`
    ).run({ chatId, botId, query });
    return result.changes;
  }

  clearScope(chatId: string, botId: string, scope: MemoryScope): number {
    const result = scope === "global"
      ? this.db.prepare("delete from memories where chatId = ? and scope = 'global'").run(chatId)
      : this.db.prepare("delete from memories where chatId = ? and scope = 'bot' and botId = ?").run(chatId, botId);
    return result.changes;
  }

  promote(chatId: string, botId: string, id: number): MemoryEntry | null {
    const entry = this.getById(id);
    if (!entry || entry.chatId !== chatId || entry.scope !== "bot" || entry.botId !== botId) return null;
    if (entry.category === "persona") {
      throw new Error("Bot 人设不能升级为 global。");
    }
    this.db.prepare(
      "update memories set scope = 'global', botId = null, updatedAt = ? where id = ?"
    ).run(Date.now(), id);
    return this.getById(id);
  }

  deleteExpired(now = Date.now()): number {
    const result = this.db.prepare("delete from memories where expiresAt is not null and expiresAt <= ?").run(now);
    return result.changes;
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists memories (
        id integer primary key autoincrement,
        chatId text not null,
        scope text not null default 'bot' check (scope in ('global', 'bot')),
        botId text,
        category text not null check (category in ('profile', 'persona', 'credential', 'fact', 'preference', 'note', 'skill')),
        title text not null,
        content text not null,
        tags text not null default '[]',
        priority integer not null default 0,
        duration text not null default 'permanent' check (duration in ('permanent', 'short_term')),
        encrypted integer not null default 0,
        expiresAt integer,
        createdAt integer not null,
        updatedAt integer not null,
        check (scope = 'global' or botId is not null),
        unique (chatId, scope, botId, category, title)
      );
      create index if not exists idx_memories_owner on memories (chatId, scope, botId);
      create index if not exists idx_memories_expiry on memories (expiresAt) where expiresAt is not null;

      create table if not exists memory_keys (
        chatId text primary key,
        salt text not null,
        verifier text not null,
        failCount integer not null default 0,
        lockedUntil integer,
        createdAt integer not null,
        updatedAt integer not null
      );
    `);
  }
}

function visibilityClause(): string {
  return "chatId = @chatId and (scope = 'global' or (scope = 'bot' and botId = @botId))";
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    chatId: row.chatId,
    scope: row.scope,
    botId: row.botId,
    category: row.category,
    title: row.title,
    content: row.content,
    tags: parseTags(row.tags),
    priority: row.priority,
    duration: row.duration,
    encrypted: row.encrypted === 1,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
