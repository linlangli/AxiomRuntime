import fs from "node:fs/promises";
import path from "node:path";
import { getLogPath } from "../config/paths.js";
import type { LogCategory, LogEvent, LogLevel } from "../types.js";

export type WriteLogInput = {
  level?: LogLevel;
  category: LogCategory;
  action: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export async function writeLog(input: WriteLogInput): Promise<void> {
  const event: LogEvent = {
    timestamp: new Date().toISOString(),
    level: input.level ?? "info",
    category: input.category,
    action: input.action,
    message: input.message,
    metadata: input.metadata
  };

  try {
    const filePath = getLogPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Logging must never break the user command.
  }
}

export async function readRecentLogs(limit = 50): Promise<LogEvent[]> {
  try {
    const raw = await fs.readFile(getLogPath(), "utf8");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map(parseLogLine)
      .filter((event): event is LogEvent => Boolean(event));
    return events.slice(-limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function ensureLogFile(): Promise<string> {
  const filePath = getLogPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, "", "utf8");
  return filePath;
}

function parseLogLine(line: string): LogEvent | null {
  try {
    const value = JSON.parse(line) as LogEvent;
    if (!value.timestamp || !value.level || !value.category || !value.action || !value.message) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
