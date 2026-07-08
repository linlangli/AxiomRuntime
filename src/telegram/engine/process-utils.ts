import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export type SpawnCaptureOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
};

export type SpawnCaptureResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
};

export async function spawnCapture(options: SpawnCaptureOptions, onProcess?: (child: ChildProcess) => void): Promise<SpawnCaptureResult> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  onProcess?.(child);

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let aborted = false;
  let killTimer: NodeJS.Timeout | undefined;

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    void options.onStdout?.(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    void options.onStderr?.(text);
  });

  const requestTermination = (reason: "timeout" | "abort"): void => {
    if (reason === "timeout") timedOut = true;
    if (reason === "abort") aborted = true;
    terminateProcessTree(child, "SIGTERM");
    killTimer ??= setTimeout(() => terminateProcessTree(child, "SIGKILL"), options.killGraceMs ?? 3000);
    killTimer.unref?.();
  };

  const abortHandler = (): void => requestTermination("abort");
  if (options.signal?.aborted) {
    requestTermination("abort");
  } else {
    options.signal?.addEventListener("abort", abortHandler, { once: true });
  }

  let timeout: NodeJS.Timeout | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeout = setTimeout(() => requestTermination("timeout"), options.timeoutMs);
    timeout.unref?.();
  }

  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve([code, signal]));
    });
    return { stdout, stderr, code, signal, timedOut, aborted };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abortHandler);
  }
}

export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child below.
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have already exited.
  }
}

export function extractJsonLines(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return events;
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
