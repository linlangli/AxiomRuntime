import { randomBytes } from "node:crypto";
import { addSession, clearSessions, readSessions, updateSession } from "../config/session-store.js";
import type { Provider, SessionRecord, ToolType } from "../types.js";

export type StartSessionInput = {
  tool: ToolType;
  provider: Provider;
  model: string;
  projectPath: string;
  fallbackFrom?: string | null;
  hermesRobot?: string | null;
};

export async function startSession(input: StartSessionInput): Promise<SessionRecord> {
  const now = new Date();
  const session: SessionRecord = {
    id: buildSessionId(now),
    tool: input.tool,
    provider: input.provider.name,
    model: input.model,
    mode: input.provider.mode,
    projectPath: input.projectPath,
    startedAt: now.toISOString(),
    endedAt: null,
    status: "running",
    exitCode: null,
    fallbackFrom: input.fallbackFrom ?? null,
    hermesRobot: input.hermesRobot ?? null
  };
  await addSession(session);
  return session;
}

export async function finishSession(sessionId: string, exitCode: number): Promise<void> {
  await updateSession(sessionId, {
    endedAt: new Date().toISOString(),
    status: exitCode === 0 ? "completed" : "failed",
    exitCode
  });
}

export async function listRecentSessions(limit = 20): Promise<SessionRecord[]> {
  const file = await readSessions();
  return [...file.sessions]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  const file = await readSessions();
  return file.sessions.find((session) => session.id === id) ?? null;
}

export async function getLastSession(): Promise<SessionRecord | null> {
  return (await listRecentSessions(1))[0] ?? null;
}

export async function clearAllSessions(): Promise<number> {
  return clearSessions();
}

function buildSessionId(date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  return `ses_${stamp}_${randomBytes(3).toString("hex")}`;
}
