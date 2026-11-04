import { getSessionsPath } from "./paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json-store.js";
import type { SessionRecord, SessionsFile } from "../types.js";
import { databaseItems, readHistoryDatabase, saveDatabaseSession, updateHistoryDatabase } from "./history-database.js";

export async function readSessions(): Promise<SessionsFile> {
  return readHistoryDatabase(async database => database ? { sessions: databaseItems<SessionRecord>(database, "sessions") }
    : normalizeSessionsFile(await readJsonFile<SessionsFile>(getSessionsPath(), { sessions: [] })));
}

export async function writeSessions(file: SessionsFile): Promise<void> {
  await updateHistoryDatabase(async database => {
    if (database) database.transaction(() => {
      database.prepare("DELETE FROM sessions").run();
      for (const session of normalizeSessionsFile(file).sessions) saveDatabaseSession(database, session);
    })();
    else await writeJsonFile(getSessionsPath(), normalizeSessionsFile(file));
  });
}

export async function addSession(session: SessionRecord): Promise<void> {
  await updateHistoryDatabase(async database => {
    if (database) { saveDatabaseSession(database, session); return; }
    await updateJsonFile<SessionsFile>(getSessionsPath(), { sessions: [] }, (file) => ({
      sessions: [...normalizeSessionsFile(file).sessions, session]
    }));
  });
}

export async function updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<void> {
  await updateHistoryDatabase(async database => {
    if (database) {
      const row = database.prepare("SELECT payload FROM sessions WHERE id = ?").get(sessionId) as { payload: string } | undefined;
      if (row) saveDatabaseSession(database, { ...JSON.parse(row.payload), ...patch, id: sessionId });
      return;
    }
    await updateJsonFile<SessionsFile>(getSessionsPath(), { sessions: [] }, (file) => ({
      sessions: normalizeSessionsFile(file).sessions.map((session) =>
        session.id === sessionId ? { ...session, ...patch, id: sessionId } : session
      )
    }));
  });
}

export async function clearSessions(): Promise<number> {
  return updateHistoryDatabase(async database => {
    if (database) return database.prepare("DELETE FROM sessions").run().changes;
    let count = 0;
    await updateJsonFile<SessionsFile>(getSessionsPath(), { sessions: [] }, (file) => {
      count = normalizeSessionsFile(file).sessions.length;
      return { sessions: [] };
    });
    return count;
  });
}

function normalizeSessionsFile(file: SessionsFile): SessionsFile {
  return { sessions: Array.isArray(file.sessions) ? file.sessions : [] };
}
