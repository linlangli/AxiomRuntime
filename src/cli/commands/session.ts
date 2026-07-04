import { clearAllSessions, getSession, listRecentSessions } from "../../core/sessions/session-service.js";
import { writeLog } from "../../core/logs/log-service.js";
import type { SessionRecord } from "../../core/types.js";
import { promptSelect } from "../prompts/prompt.js";
import { runUseCommand } from "./use.js";

export async function runSessionCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "list") {
    await printSessions();
    return;
  }
  if (subcommand === "clear") {
    await clearSessionsCommand();
    return;
  }
  if (subcommand === "resume" && args[1]) {
    await resumeSession(args[1]);
    return;
  }
  if (subcommand && subcommand !== "list") {
    throw new Error(`Unknown session command: ${subcommand}`);
  }
  await runSessionInteractive();
}

async function runSessionInteractive(): Promise<void> {
  const sessions = await listRecentSessions(20);
  if (!sessions.length) {
    console.log("No sessions found.");
    return;
  }

  const sessionId = await promptSelect(
    "Select session to resume",
    sessions.map((session) => ({ label: formatSessionLabel(session), value: session.id }))
  );
  await resumeSession(sessionId);
}

async function resumeSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  console.log(`Resuming ${session.tool}: ${session.provider} / ${session.model}`);
  await runUseCommand([session.tool, session.provider, session.model]);
}

async function printSessions(): Promise<void> {
  const sessions = await listRecentSessions(20);
  if (!sessions.length) {
    console.log("No sessions found.");
    return;
  }

  console.log(`AI Gateway Sessions (${sessions.length})`);
  console.log("=".repeat(88));
  sessions.forEach((session, index) => {
    console.log(`${index + 1}. ${formatSessionLabel(session)}`);
    console.log(`   id       ${session.id}`);
    console.log(`   project  ${session.projectPath}`);
    console.log(`   status   ${session.status}${session.exitCode === null ? "" : ` (${session.exitCode})`}`);
    if (session.fallbackFrom) {
      console.log(`   fallback ${session.fallbackFrom} -> ${session.provider}`);
    }
    if (index < sessions.length - 1) {
      console.log("-".repeat(88));
    }
  });
}

async function clearSessionsCommand(): Promise<void> {
  const count = await clearAllSessions();
  await writeLog({
    category: "usage",
    action: "sessions_cleared",
    message: `Cleared ${count} session(s).`,
    metadata: { count }
  });
  console.log(`Cleared ${count} session(s).`);
}

function formatSessionLabel(session: SessionRecord): string {
  return `${session.startedAt}  ${session.tool}  ${session.provider}  ${session.model}`;
}
