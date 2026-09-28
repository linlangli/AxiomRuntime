import { spawn } from "node:child_process";
import type { LogEvent } from "../../core/types.js";
import { ensureLogFile, readRecentLogs } from "../../core/logs/log-service.js";

export async function runLogCommand(args: string[]): Promise<void> {
  if (!args.includes("--print")) {
    const filePath = await ensureLogFile();
    await openFile(filePath);
    console.log(`Opened log file: ${filePath}`);
    return;
  }

  const traceId = parseTraceId(args);
  const printableArgs = args.filter((arg) => arg !== "--print" && arg !== "--trace" && arg !== traceId);
  const limit = parseLimit(printableArgs[0]);
  const logs = await readRecentLogs(traceId ? Math.max(limit, 500) : limit);
  if (!traceId) {
    printLogs(logs);
    return;
  }

  // 按 traceId 聚合成一条调用链路：同一次请求的每一跳按时间先后排成一列。
  const chain = logs.filter((event) => event.traceId === traceId);
  if (!chain.length) {
    console.log(`No logs found for trace ${traceId}.`);
    return;
  }
  printLogs(chain);
}

function parseTraceId(args: string[]): string | undefined {
  const index = args.indexOf("--trace");
  if (index === -1) return undefined;
  const value = args[index + 1]?.trim();
  return value && !value.startsWith("--") ? value : undefined;
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

function parseLimit(value: string | undefined): number {
  if (!value) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 50;
  }
  return Math.min(parsed, 500);
}

function printLogs(logs: LogEvent[]): void {
  if (!logs.length) {
    console.log("No logs found.");
    return;
  }

  console.log(`AI Gateway Logs (${logs.length})`);
  console.log("=".repeat(88));

  logs.forEach((event, index) => {
    const badge = formatBadge(event.level);
    console.log(`${index + 1}. ${badge} ${event.timestamp}`);
    console.log(`   ${event.category} / ${event.action}`);
    console.log(`   ${event.message}`);

    if (event.traceId) {
      console.log(`   trace: ${event.traceId}`);
    }

    if (event.metadata && Object.keys(event.metadata).length) {
      console.log(`   metadata: ${formatMetadata(event.metadata)}`);
    }

    if (index < logs.length - 1) {
      console.log("-".repeat(88));
    }
  });
}

function formatBadge(level: LogEvent["level"]): string {
  if (level === "error") return "[ERROR]";
  if (level === "warn") return "[WARN ]";
  return "[INFO ]";
}

function formatMetadata(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata);
}
