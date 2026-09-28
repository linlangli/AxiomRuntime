import fs from "node:fs/promises";
import path from "node:path";
import { getTelegramLogPath } from "../core/config/paths.js";
import { writeLog } from "../core/logs/log-service.js";

export type TelegramLogInput = {
  level?: "info" | "warn" | "error";
  action: string;
  message: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
};

export async function writeTelegramLog(input: TelegramLogInput): Promise<void> {
  const line = {
    timestamp: new Date().toISOString(),
    level: input.level ?? "info",
    action: input.action,
    message: input.message,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    metadata: input.metadata
  };

  await writeLog({
    level: line.level,
    category: "telegram",
    action: line.action,
    message: line.message,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    metadata: line.metadata
  });

  try {
    const filePath = getTelegramLogPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // Logging must never break bot execution.
  }
}

export async function readRecentTelegramLogLines(limit = 50): Promise<string[]> {
  try {
    const raw = await fs.readFile(getTelegramLogPath(), "utf8");
    return raw.split("\n").filter(Boolean).slice(-limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function ensureTelegramLogFile(): Promise<string> {
  const filePath = getTelegramLogPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, "", "utf8");
  return filePath;
}
