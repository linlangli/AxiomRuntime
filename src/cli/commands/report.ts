import { spawn } from "node:child_process";
import { generateSessionReport } from "../../core/reports/report-service.js";
import { listRecentSessions } from "../../core/sessions/session-service.js";
import type { SessionRecord } from "../../core/types.js";
import { promptSelect } from "../prompts/prompt.js";

export async function runReportCommand(args: string[]): Promise<void> {
  const shouldPrint = args.includes("--print");
  const sessionId = args.find((arg) => arg !== "--print") ?? await selectSession();
  const report = await generateSessionReport(sessionId);

  if (shouldPrint) {
    console.log(report.content);
    return;
  }

  await openFile(report.filePath);
  console.log(`Opened report file: ${report.filePath}`);
}

async function selectSession(): Promise<string> {
  const sessions = await listRecentSessions(20);
  if (!sessions.length) {
    throw new Error("No sessions found. Run `ai use` first.");
  }

  return promptSelect(
    "Select session for report",
    sessions.map((session) => ({ label: formatSessionLabel(session), value: session.id }))
  );
}

function formatSessionLabel(session: SessionRecord): string {
  return `${session.startedAt}  ${session.tool}  ${session.provider}  ${session.model}  ${session.status}`;
}

async function openFile(filePath: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];

  await new Promise<void>((resolve) => {
    const child = spawn(opener, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    child.unref();
  });
}
