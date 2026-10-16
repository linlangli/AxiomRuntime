import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  update: 5_000,
  retries: {
    retries: 100,
    factor: 1.2,
    minTimeout: 25,
    maxTimeout: 500
  }
} satisfies lockfile.LockOptions;

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseJsonWithTrailingRecovery(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await withJsonFileLock(filePath, () => writeJsonFileUnlocked(filePath, value));
}

export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  updater: (current: T) => T | Promise<T>
): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  return withJsonFileLock(filePath, async () => {
    const current = await readJsonFile(filePath, fallback);
    const next = await updater(current);
    await writeJsonFileUnlocked(filePath, next);
    return next;
  });
}

export async function withJsonFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function writeJsonFileUnlocked<T>(filePath: string, value: T): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseJsonWithTrailingRecovery(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const prefix = extractFirstJsonValue(raw);
    if (!prefix) throw error;
    return JSON.parse(prefix);
  }
}

function extractFirstJsonValue(raw: string): string | null {
  const start = raw.search(/\S/);
  if (start < 0) return null;
  const opener = raw[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return null;
}
