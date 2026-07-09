import { getSessionsPath } from "./paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json-store.js";
import type { SessionRecord, SessionsFile } from "../types.js";

export async function readSessions(): Promise<SessionsFile> {
  const file = await readJsonFile<SessionsFile>(getSessionsPath(), { sessions: [] });
  return normalizeSessionsFile(file);
}

export async function writeSessions(file: SessionsFile): Promise<void> {
  await writeJsonFile(getSessionsPath(), normalizeSessionsFile(file));
}

export async function addSession(session: SessionRecord): Promise<void> {
  await updateJsonFile<SessionsFile>(getSessionsPath(), { sessions: [] }, (file) => ({
    sessions: [...normalizeSessionsFile(file).sessions, session]
  }));
}

export async function updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<void> {
  await updateJsonFile<SessionsFile>(getSessionsPath(), { sessions: [] }, (file) => ({
    sessions: normalizeSessionsFile(file).sessions.map((session) =>
      session.id === sessionId ? { ...session, ...patch } : session
    )
  }));
}

export async function clearSessions(): Promise<number> {
  let count = 0;
  await updateJsonFile<SessionsFile>(getSessionsPath(), { sessions: [] }, (file) => {
    count = normalizeSessionsFile(file).sessions.length;
    return { sessions: [] };
  });
  return count;
}

function normalizeSessionsFile(file: SessionsFile): SessionsFile {
  return { sessions: Array.isArray(file.sessions) ? file.sessions : [] };
}
