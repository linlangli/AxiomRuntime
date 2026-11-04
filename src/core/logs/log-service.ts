import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { getLogPath } from "../config/paths.js";
import type { LogCategory, LogEvent, LogLevel } from "../types.js";

export type LogContext = { traceId?: string; sessionId?: string; executionId?: string };
const contexts = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(context: LogContext, operation: () => T): T {
  return contexts.run({ ...contexts.getStore(), ...context }, operation);
}

export function getLogContext(): LogContext {
  return contexts.getStore() ?? {};
}

/**
 * 生成一条调用链路的关联 id。一次请求/任务只调用一次，之后的每一跳复用同一个值，
 * 调用链路视图才能把多个 provider 尝试归并成一条链路。
 */
export function newTraceId(): string {
  return `trc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export type WriteLogInput = {
  level?: LogLevel;
  category: LogCategory;
  action: string;
  message: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
};

export async function writeLog(input: WriteLogInput): Promise<void> {
  const context = getLogContext();
  const traceId = input.traceId ?? context.traceId;
  const event: LogEvent = {
    timestamp: new Date().toISOString(),
    level: input.level ?? "info",
    category: input.category,
    action: input.action,
    message: input.message,
    ...(traceId ? { traceId } : {}),
    metadata: {
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.executionId ? { executionId: context.executionId } : {}),
      ...input.metadata
    }
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
  const events: LogEvent[] = [];
  if (limit <= 0) return events;
  for await (const event of iterateLogsNewestFirst()) {
    events.push(event);
    if (events.length >= limit) break;
  }
  return events.reverse();
}

export async function* iterateLogsNewestFirst(): AsyncGenerator<LogEvent> {
  let file;
  try {
    file = await fs.open(getLogPath(), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    let position = (await file.stat()).size;
    let carry = Buffer.alloc(0);
    let skippingOversized = false;
    while (position > 0) {
      const length = Math.min(position, 65_536);
      position -= length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await file.read(chunk, 0, length, position);
      const buffer = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      let end = buffer.length;
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 10) continue;
        if (!skippingOversized) {
          const event = parseLogLine(buffer.subarray(index + 1, end).toString("utf8"));
          if (event) yield event;
        }
        skippingOversized = false;
        end = index;
      }
      carry = buffer.subarray(0, end);
      if (carry.length > 4 * 1024 * 1024) { carry = Buffer.alloc(0); skippingOversized = true; }
    }
    if (!skippingOversized) {
      const event = parseLogLine(carry.toString("utf8"));
      if (event) yield event;
    }
  } finally { await file.close(); }
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
