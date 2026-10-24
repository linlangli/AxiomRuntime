import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function findNativeCodexSession(input: {
  cwd: string; startedAt: number; finishedAt: number; codexHome?: string;
}): Promise<string | undefined> {
  const home = input.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const cwd = await fs.realpath(input.cwd).catch(() => path.resolve(input.cwd));
  const directories = new Set<string>();
  for (const timestamp of [input.startedAt - 86_400_000, input.startedAt, input.startedAt + 86_400_000, input.finishedAt]) {
    const date = new Date(timestamp);
    for (const [year, month, day] of [
      [date.getFullYear(), date.getMonth() + 1, date.getDate()],
      [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    ]) directories.add(path.join(home, "sessions", String(year), String(month).padStart(2, "0"), String(day).padStart(2, "0")));
  }
  const matches = new Set<string>();
  for (const directory of directories) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = await fs.open(path.join(directory, entry.name), "r").catch(() => null);
      if (!file) continue;
      try {
        const buffer = Buffer.alloc(65_536);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const first = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]!);
        const metadata = first.payload;
        const timestamp = Date.parse(first.timestamp ?? metadata?.timestamp ?? "");
        if (first.type !== "session_meta" || !metadata || typeof metadata.cwd !== "string") continue;
        if (await fs.realpath(metadata.cwd).catch(() => path.resolve(metadata.cwd)) !== cwd) continue;
        if (metadata.source !== "cli" || !Number.isFinite(timestamp) || timestamp < input.startedAt - 1000 || timestamp > input.finishedAt + 1000) continue;
        if (typeof metadata.id === "string" && /^[a-f0-9-]{36}$/i.test(metadata.id)) matches.add(metadata.id);
      } catch {
        continue;
      } finally {
        await file.close();
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}
