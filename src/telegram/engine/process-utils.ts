import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export type SpawnCaptureOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
};

export type SpawnCaptureResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

export async function spawnCapture(options: SpawnCaptureOptions, onProcess?: (child: ChildProcess) => void): Promise<SpawnCaptureResult> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    signal: options.signal
  });
  onProcess?.(child);

  let stdout = "";
  let stderr = "";

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

  const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  return { stdout, stderr, code, signal };
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
