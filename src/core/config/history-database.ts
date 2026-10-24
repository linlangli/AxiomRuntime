import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigRoot, getSessionsPath, getUsagePath } from "./paths.js";
import { readJsonFile, withJsonFileLock, writeJsonFile } from "./json-store.js";
import type { SessionRecord, UsageEvent } from "../types.js";

function databasePath() { return path.join(getConfigRoot(), "history.sqlite"); }
function backendPath() { return path.join(getConfigRoot(), "history-storage.json"); }

async function exists(file: string) {
  try { await fs.access(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function readHistoryDatabase<T>(operation: (database: Database.Database | null) => T | Promise<T>): Promise<T> {
  if (!await exists(databasePath())) {
    if (await exists(backendPath())) throw new Error("Active history.sqlite is missing; restore a verified backup. Automatic JSON fallback is disabled.");
    return operation(null);
  }
  const database = new Database(databasePath(), { fileMustExist: true, timeout: 10_000 });
  try {
    if (database.pragma("user_version", { simple: true }) !== 1) throw new Error("Unsupported history.sqlite schema; automatic JSON fallback is disabled.");
    return await operation(database);
  } finally { database.close(); }
}

export async function updateHistoryDatabase<T>(operation: (database: Database.Database | null) => T | Promise<T>): Promise<T> {
  return withJsonFileLock(path.join(getConfigRoot(), ".history-storage"), () => readHistoryDatabase(operation));
}

export function appendDatabaseUsage(database: Database.Database, events: UsageEvent[]): number {
  const insert = database.prepare("INSERT INTO usage (id, timestamp, provider, session_id, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING");
  return database.transaction(() => events.reduce((count, event) => count + insert.run(event.id ?? null, event.createdAt, event.provider, event.sessionId ?? null, JSON.stringify(event)).changes, 0))();
}

export function saveDatabaseSession(database: Database.Database, session: SessionRecord): void {
  database.prepare("INSERT INTO sessions (id, timestamp, provider, actual_provider, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp, provider=excluded.provider, actual_provider=excluded.actual_provider, payload=excluded.payload")
    .run(session.id, session.startedAt, session.provider, session.actualProvider ?? null, JSON.stringify(session));
}

export function databaseItems<T>(database: Database.Database, kind: "usage" | "sessions"): T[] {
  return (database.prepare(`SELECT payload FROM ${kind} ORDER BY seq`).all() as { payload: string }[]).map(row => JSON.parse(row.payload) as T);
}

export async function historyStorageStatus() {
  return readHistoryDatabase(database => ({ backend: database ? "sqlite" : "json", path: database ? databasePath() : getConfigRoot(),
    ...(database ? { usageEvents: (database.prepare("SELECT COUNT(*) AS count FROM usage").get() as { count: number }).count, sessions: (database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count } : {}) }));
}

export async function migrateHistoryStorage() {
  await updateHistoryDatabase(async existing => {
    if (existing) return;
    const usage = await readJsonFile<{ events: UsageEvent[] }>(getUsagePath(), { events: [] });
    const sessions = await readJsonFile<{ sessions: SessionRecord[] }>(getSessionsPath(), { sessions: [] });
    if (!Array.isArray(usage.events) || !Array.isArray(sessions.sessions)) throw new Error("Invalid legacy usage or session document; migration cancelled.");
    const temporary = path.join(getConfigRoot(), `.history-${randomUUID()}.sqlite`);
    await fs.writeFile(temporary, "", { mode: 0o600 });
    const database = new Database(temporary);
    try {
      database.exec(`
        CREATE TABLE usage (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, timestamp TEXT NOT NULL, provider TEXT NOT NULL, session_id TEXT, payload TEXT NOT NULL);
        CREATE INDEX usage_time ON usage(timestamp);
        CREATE INDEX usage_provider_time ON usage(provider, timestamp);
        CREATE INDEX usage_session ON usage(session_id);
        CREATE TABLE sessions (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, timestamp TEXT NOT NULL, provider TEXT NOT NULL, actual_provider TEXT, payload TEXT NOT NULL);
        CREATE INDEX sessions_time ON sessions(timestamp);
        CREATE INDEX sessions_provider_time ON sessions(provider, timestamp);
        CREATE INDEX sessions_actual_provider ON sessions(actual_provider, timestamp);
        PRAGMA user_version = 1;
      `);
      database.transaction(() => {
        appendDatabaseUsage(database, usage.events);
        for (const session of sessions.sessions) saveDatabaseSession(database, session);
      })();
      if (database.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("History migration integrity check failed.");
      database.close();
      await fs.rename(temporary, databasePath());
      await writeJsonFile(backendPath(), { version: 1, backend: "sqlite" });
    } finally {
      if (database.open) database.close();
      await fs.rm(temporary, { force: true });
    }
  });
  return historyStorageStatus();
}

export async function backupHistoryStorage(): Promise<string> {
  return updateHistoryDatabase(async database => {
    if (!database) throw new Error("Run `ai history migrate` before creating a SQLite history backup.");
    const directory = path.join(getConfigRoot(), "history-backups");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${randomUUID()}.sqlite`);
    await fs.writeFile(file, "", { mode: 0o600 });
    try { await database.backup(file); }
    catch (error) { await fs.rm(file, { force: true }); throw error; }
    return file;
  });
}

export async function rollbackHistoryStorage() {
  await withJsonFileLock(path.join(getConfigRoot(), ".history-storage"), async () => {
    const active = await readHistoryDatabase(async database => {
      if (!database) return false;
      await writeJsonFile(getUsagePath(), { events: databaseItems<UsageEvent>(database, "usage") });
      await writeJsonFile(getSessionsPath(), { sessions: databaseItems<SessionRecord>(database, "sessions") });
      return true;
    });
    if (active) {
      const directory = path.join(getConfigRoot(), "history-backups");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.rename(databasePath(), path.join(directory, `rollback-${randomUUID()}.sqlite`));
      await fs.rm(backendPath(), { force: true });
    }
  });
  return historyStorageStatus();
}

export async function restoreHistoryStorage(id: string) {
  if (!/^(?:rollback-)?[a-f0-9-]{36}\.sqlite$/i.test(id)) throw new Error("Invalid history backup ID; use the filename returned by `ai history backup`.");
  await withJsonFileLock(path.join(getConfigRoot(), ".history-storage"), async () => {
    const source = path.join(getConfigRoot(), "history-backups", id);
    const backup = new Database(source, { fileMustExist: true, readonly: true });
    const temporary = path.join(getConfigRoot(), `.history-${randomUUID()}.sqlite`);
    try {
      if (backup.pragma("user_version", { simple: true }) !== 1 || backup.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Invalid history backup; current storage was not changed.");
      backup.prepare("SELECT seq, id, timestamp, provider, session_id, payload FROM usage LIMIT 0").all();
      backup.prepare("SELECT seq, id, timestamp, provider, actual_provider, payload FROM sessions LIMIT 0").all();
      await fs.writeFile(temporary, "", { mode: 0o600 });
      await backup.backup(temporary);
      if (await exists(databasePath())) {
        const before = path.join(getConfigRoot(), "history-backups", `${randomUUID()}.sqlite`);
        await fs.writeFile(before, "", { mode: 0o600 });
        try { await readHistoryDatabase(async current => { await current!.backup(before); }); }
        catch { await fs.copyFile(databasePath(), before); await fs.chmod(before, 0o600); }
      }
      await fs.rename(temporary, databasePath());
      await writeJsonFile(backendPath(), { version: 1, backend: "sqlite" });
    } finally {
      backup.close();
      await fs.rm(temporary, { force: true });
    }
  });
  return historyStorageStatus();
}

export async function queryDatabaseHistory(kind: "usage" | "sessions", input: URLSearchParams, limit: number, offset: number) {
  return readHistoryDatabase(database => {
    if (!database) return null;
    const clauses: string[] = [];
    const values: string[] = [];
    const provider = input.get("provider");
    if (provider) { clauses.push(kind === "sessions" ? "(provider = ? OR actual_provider = ?)" : "provider = ?"); values.push(provider); if (kind === "sessions") values.push(provider); }
    for (const [key, operator] of [["since", ">="], ["before", "<="]]) {
      const value = input.get(key!);
      if (value) { clauses.push(`timestamp ${operator} ?`); values.push(value); }
    }
    const query = input.get("q")?.toLowerCase();
    if (query) {
      const fields = kind === "usage" ? ["id", "createdAt", "provider", "model", "traceId", "sessionId", "inputTokens", "outputTokens", "totalTokens", "costUsd", "costSource"]
        : ["id", "tool", "provider", "model", "actualProvider", "actualModel", "startedAt", "endedAt", "status", "exitCode", "nativeSessionId", "traceId", "resumedFrom"];
      clauses.push(`(${fields.map(field => `instr(lower(CAST(COALESCE(json_extract(payload, '$.${field}'), '') AS TEXT)), ?) > 0`).join(" OR ")})`);
      values.push(...fields.map(() => query));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (database.prepare(`SELECT COUNT(*) AS count FROM ${kind} ${where}`).get(...values) as { count: number }).count;
    const items = (database.prepare(`SELECT payload FROM ${kind} ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as { payload: string }[]).map(row => JSON.parse(row.payload));
    return { total, items };
  });
}
