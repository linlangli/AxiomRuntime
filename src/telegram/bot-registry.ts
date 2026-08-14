import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  getConfigRoot,
  getTelegramBotConfigPath,
  getTelegramBotDbPath,
  getTelegramBotDir,
  getTelegramBotLogPath,
  getTelegramBotPidPath,
  getTelegramConfigPath
} from "../core/config/paths.js";

export type BotEntry = {
  name: string;
  configPath: string;
};

const BOT_NAME_RE = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/;
const LEGACY_MIGRATION_MARKER = ".telegram-legacy-migrated";

export function isValidBotName(name: string): boolean {
  return BOT_NAME_RE.test(name) && name.length <= 32;
}

export function listBots(): BotEntry[] {
  const dir = getTelegramBotDir();
  if (!fs.existsSync(dir)) return [];
  const entries: BotEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".json")) {
      const name = file.slice(0, -5);
      entries.push({ name, configPath: path.join(dir, file) });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function botExists(name: string): boolean {
  return fs.existsSync(getTelegramBotConfigPath(name));
}

export function isBotRunning(name: string): { running: boolean; pid: number | null } {
  const pidPath = getTelegramBotPidPath(name);
  if (!fs.existsSync(pidPath)) return { running: false, pid: null };
  const raw = fs.readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid };
  }
}

export async function migrateLegacyConfig(): Promise<void> {
  const legacyPath = getTelegramConfigPath();
  if (!fs.existsSync(legacyPath)) return;
  if (fs.existsSync(getLegacyMigrationMarkerPath())) return;

  const dir = getTelegramBotDir();
  await fsPromises.mkdir(dir, { recursive: true });
  if (!botExists("default")) {
    await fsPromises.copyFile(legacyPath, getTelegramBotConfigPath("default"));
  }
  await markLegacyMigrationComplete();
}

export async function removeBotFiles(name: string): Promise<void> {
  if (name === "default") {
    await markLegacyMigrationComplete();
  }
  const paths = [
    getTelegramBotConfigPath(name),
    getTelegramBotPidPath(name),
    getTelegramBotLogPath(name),
    getTelegramBotDbPath(name)
  ];
  for (const p of paths) {
    try {
      await fsPromises.unlink(p);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function getLegacyMigrationMarkerPath(): string {
  return path.join(getConfigRoot(), LEGACY_MIGRATION_MARKER);
}

async function markLegacyMigrationComplete(): Promise<void> {
  await fsPromises.mkdir(getConfigRoot(), { recursive: true });
  await fsPromises.writeFile(getLegacyMigrationMarkerPath(), "completed\n", { mode: 0o600 });
}
