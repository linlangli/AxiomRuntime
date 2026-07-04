import { getSessionsPath } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { SessionRecord, SessionsFile } from "../types.js";

export async function readSessions(): Promise<SessionsFile> {
  const file = await readJsonFile<SessionsFile>(getSessionsPath(), { sessions: [] });
  return { sessions: Array.isArray(file.sessions) ? file.sessions : [] };
}

export async function writeSessions(file: SessionsFile): Promise<void> {
  await writeJsonFile(getSessionsPath(), { sessions: file.sessions });
}

export async function addSession(session: SessionRecord): Promise<void> {
  const file = await readSessions();
  file.sessions.push(session);
  await writeSessions(file);
}

export async function updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<void> {
  const file = await readSessions();
  file.sessions = file.sessions.map((session) =>
    session.id === sessionId ? { ...session, ...patch } : session
  );
  await writeSessions(file);
}
