import fs from "node:fs/promises";
import os from "node:os";
import { getTelegramBotConfigPath, getTelegramBotDbPath, getTelegramBotDir, getTelegramConfigPath, getTelegramDbPath } from "../core/config/paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "../core/config/json-store.js";
import { readBoolean, readNumber, readOptionalString, readString } from "../core/config/schema.js";

export type TelegramEngineName = "claude" | "codex";
export type TelegramPermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export type TelegramConfig = {
  token: string;
  allowAllUsers: boolean;
  allowedUserIds: number[];
  defaultEngine: TelegramEngineName;
  defaultCwd: string;
  defaultPermissionMode: TelegramPermissionMode;
  sessionTimeoutHours: number;
  maxOutputLength: number;
  provider?: string;
  model?: string;
  proxyUrl?: string;
  dbPath: string;
};

const VALID_ENGINES = new Set<TelegramEngineName>(["claude", "codex"]);
const VALID_PERMISSION_MODES = new Set<TelegramPermissionMode>(["default", "acceptEdits", "bypassPermissions"]);

export async function loadTelegramConfig(): Promise<TelegramConfig> {
  const raw = await readJsonFile<unknown>(getTelegramConfigPath(), getDefaultTelegramConfig());
  return normalizeTelegramConfig(raw);
}

export async function saveTelegramConfig(config: TelegramConfig): Promise<TelegramConfig> {
  const normalized = normalizeTelegramConfig(config);
  await writeJsonFile(getTelegramConfigPath(), normalized);
  await chmodConfigFile();
  return normalized;
}

export async function updateTelegramConfig(patch: Partial<TelegramConfig>): Promise<TelegramConfig> {
  const next = await updateJsonFile(getTelegramConfigPath(), getDefaultTelegramConfig(), (current) =>
    normalizeTelegramConfig({ ...normalizeTelegramConfig(current), ...patch })
  );
  await chmodConfigFile();
  return normalizeTelegramConfig(next);
}

export async function setTelegramConfigValue(key: string, value: string): Promise<TelegramConfig> {
  if (!isTelegramConfigKey(key)) {
    throw new Error(`Unknown telegram config key: ${key}`);
  }
  const parsed = parseTelegramConfigValue(key, value);
  return updateTelegramConfig({ [key]: parsed } as Partial<TelegramConfig>);
}

export function normalizeTelegramConfig(value: unknown): TelegramConfig {
  const defaults = getDefaultTelegramConfig();
  const input = isConfigRecord(value) ? value : {};
  const defaultEngine = readString(input, "defaultEngine", { fallback: defaults.defaultEngine });
  const defaultPermissionMode = normalizePermissionMode(readString(input, "defaultPermissionMode", { fallback: defaults.defaultPermissionMode }));
  const sessionTimeoutHours = readNumber(input, "sessionTimeoutHours", defaults.sessionTimeoutHours);
  const maxOutputLength = readNumber(input, "maxOutputLength", defaults.maxOutputLength);
  const allowedUserIds = normalizeAllowedUserIds(input.allowedUserIds);
  const provider = readOptionalString(input, "provider");
  const model = readOptionalString(input, "model");
  const proxyUrl = readOptionalString(input, "proxyUrl");
  const dbPath = readString(input, "dbPath", { fallback: defaults.dbPath }) || defaults.dbPath;

  return {
    token: readString(input, "token", { fallback: defaults.token }),
    allowAllUsers: readBoolean(input.allowAllUsers ?? defaults.allowAllUsers),
    allowedUserIds,
    defaultEngine: VALID_ENGINES.has(defaultEngine as TelegramEngineName) ? defaultEngine as TelegramEngineName : defaults.defaultEngine,
    defaultCwd: String(input.defaultCwd ?? defaults.defaultCwd).trim() || defaults.defaultCwd,
    defaultPermissionMode,
    sessionTimeoutHours: Number.isFinite(sessionTimeoutHours) && sessionTimeoutHours > 0 ? sessionTimeoutHours : defaults.sessionTimeoutHours,
    maxOutputLength: Number.isFinite(maxOutputLength) && maxOutputLength >= 500 ? maxOutputLength : defaults.maxOutputLength,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
    dbPath
  };
}

export function parseTelegramConfigValue(key: keyof TelegramConfig, rawValue: string): TelegramConfig[keyof TelegramConfig] {
  const value = rawValue.trim();
  if (key === "allowedUserIds") {
    return normalizeAllowedUserIds(value);
  }
  if (key === "allowAllUsers") {
    return parseBoolean(value);
  }
  if (key === "sessionTimeoutHours" || key === "maxOutputLength") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${key} must be a positive number.`);
    }
    return parsed;
  }
  if (key === "defaultEngine") {
    if (!VALID_ENGINES.has(value as TelegramEngineName)) {
      throw new Error("defaultEngine must be claude or codex.");
    }
    return value as TelegramEngineName;
  }
  if (key === "defaultPermissionMode") {
    return normalizePermissionMode(value);
  }
  return value;
}

export function normalizePermissionMode(value: string): TelegramPermissionMode {
  if (value === "auto-edit") return "acceptEdits";
  if (value === "full-auto") return "bypassPermissions";
  if (VALID_PERMISSION_MODES.has(value as TelegramPermissionMode)) return value as TelegramPermissionMode;
  return getDefaultTelegramConfig().defaultPermissionMode;
}

export function describeTelegramConfig(config: TelegramConfig): string[] {
  return [
    `token: ${config.token ? maskToken(config.token) : "(empty)"}`,
    `allowAllUsers: ${config.allowAllUsers ? "true" : "false"}`,
    `allowedUserIds: ${config.allowedUserIds.length ? config.allowedUserIds.join(", ") : "(empty)"}`,
    `defaultEngine: ${config.defaultEngine}`,
    `defaultCwd: ${config.defaultCwd}`,
    `defaultPermissionMode: ${config.defaultPermissionMode}`,
    `sessionTimeoutHours: ${config.sessionTimeoutHours}`,
    `maxOutputLength: ${config.maxOutputLength}`,
    `provider: ${config.provider ?? "(auto)"}`,
    `model: ${config.model ?? "(auto)"}`,
    `proxyUrl: ${config.proxyUrl ?? "(none)"}`,
    `dbPath: ${config.dbPath}`
  ];
}

function normalizeAllowedUserIds(value: unknown): number[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/).filter(Boolean)
      : [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of items) {
    const parsed = Number(item);
    if (Number.isInteger(parsed) && parsed > 0 && !seen.has(parsed)) {
      seen.add(parsed);
      ids.push(parsed);
    }
  }
  return ids;
}

function getDefaultTelegramConfig(): TelegramConfig {
  return {
    token: "",
    allowAllUsers: false,
    allowedUserIds: [],
    defaultEngine: "claude",
    defaultCwd: os.homedir(),
    defaultPermissionMode: "bypassPermissions",
    sessionTimeoutHours: 24,
    maxOutputLength: 4000,
    dbPath: getTelegramDbPath()
  };
}

function isTelegramConfigKey(key: string): key is keyof TelegramConfig {
  return [
    "token",
    "allowAllUsers",
    "allowedUserIds",
    "defaultEngine",
    "defaultCwd",
    "defaultPermissionMode",
    "sessionTimeoutHours",
    "maxOutputLength",
    "provider",
    "model",
    "proxyUrl",
    "dbPath"
  ].includes(key);
}

function parseBoolean(value: unknown): boolean {
  return readBoolean(value);
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function chmodConfigFile(): Promise<void> {
  try {
    await fs.chmod(getTelegramConfigPath(), 0o600);
  } catch {
    // Best-effort on filesystems that may not support chmod.
  }
}

function maskToken(token: string): string {
  if (token.length <= 12) return "****";
  return `${token.slice(0, 6)}****${token.slice(-4)}`;
}

export async function loadBotConfig(name: string): Promise<TelegramConfig> {
  const configPath = getTelegramBotConfigPath(name);
  const defaults = getDefaultBotConfig(name);
  const raw = await readJsonFile<unknown>(configPath, defaults);
  return normalizeTelegramConfig(raw);
}

export async function saveBotConfig(name: string, config: TelegramConfig): Promise<TelegramConfig> {
  const configPath = getTelegramBotConfigPath(name);
  const dir = getTelegramBotDir();
  await fs.mkdir(dir, { recursive: true });
  const withDb = { ...config, dbPath: config.dbPath || getTelegramBotDbPath(name) };
  const normalized = normalizeTelegramConfig(withDb);
  if (normalized.dbPath === getTelegramDbPath()) {
    normalized.dbPath = getTelegramBotDbPath(name);
  }
  await writeJsonFile(configPath, normalized);
  try {
    await fs.chmod(configPath, 0o600);
  } catch {
    // Best-effort on filesystems that may not support chmod.
  }
  return normalized;
}

function getDefaultBotConfig(name: string): TelegramConfig {
  return {
    token: "",
    allowAllUsers: false,
    allowedUserIds: [],
    defaultEngine: "claude",
    defaultCwd: os.homedir(),
    defaultPermissionMode: "bypassPermissions",
    sessionTimeoutHours: 24,
    maxOutputLength: 4000,
    dbPath: getTelegramBotDbPath(name)
  };
}
