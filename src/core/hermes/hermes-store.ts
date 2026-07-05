import fs from "node:fs/promises";
import path from "node:path";
import { getHermesRobotsPath, getHermesStatePath, getLegacyHermesRobotsPath } from "../config/paths.js";
import { readJsonFile, writeJsonFile } from "../config/json-store.js";
import type { HermesRobot, HermesRobotsFile, HermesRobotState, HermesStateFile } from "./hermes-types.js";

const EMPTY_ROBOTS: HermesRobotsFile = { robots: [] };
const EMPTY_STATE: HermesStateFile = { robots: {} };

export async function readHermesRobots(): Promise<HermesRobotsFile> {
  const raw = await readHermesConfig();
  if (Array.isArray(raw)) {
    return { robots: normalizeRobots(raw.map(normalizeRobotShape)) };
  }
  if (!isRecord(raw) || !Array.isArray(raw.robots)) {
    throw new Error("hermes.json must contain a JSON array or { robots: [] }.");
  }
  return { robots: normalizeRobots(raw.robots.map(normalizeRobotShape)) };
}

export async function writeHermesRobots(file: HermesRobotsFile): Promise<void> {
  await writeJsonFile(getHermesRobotsPath(), normalizeRobots(file.robots).map(toUserEditableRobot));
}

async function readHermesConfig(): Promise<unknown> {
  try {
    await fs.access(getHermesRobotsPath());
    return await readJsonFile<unknown>(getHermesRobotsPath(), EMPTY_ROBOTS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await fs.access(getLegacyHermesRobotsPath());
    const legacy = await readJsonFile<unknown>(getLegacyHermesRobotsPath(), EMPTY_ROBOTS);
    const robots = isRecord(legacy) && Array.isArray(legacy.robots)
      ? legacy.robots
      : Array.isArray(legacy)
        ? legacy
        : [];
    await writeJsonFile(getHermesRobotsPath(), robots);
    return robots;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_ROBOTS;
    }
    throw error;
  }
}

export async function readHermesState(): Promise<HermesStateFile> {
  const raw = await readJsonFile<HermesStateFile>(getHermesStatePath(), EMPTY_STATE);
  return { robots: raw.robots ?? {} };
}

export async function writeHermesState(file: HermesStateFile): Promise<void> {
  await writeJsonFile(getHermesStatePath(), { robots: file.robots ?? {} });
}

export async function upsertHermesRobotState(robot: string, patch: Partial<HermesRobotState>): Promise<HermesRobotState> {
  const state = await readHermesState();
  const current = state.robots[robot] ?? {
    robot,
    lastUsedAt: null,
    lastSessionId: null,
    lastError: null,
    clearedAt: null
  };
  const next = { ...current, ...patch, robot };
  state.robots[robot] = next;
  await writeHermesState(state);
  return next;
}

export async function clearHermesRobotState(robot: string): Promise<void> {
  const state = await readHermesState();
  state.robots[robot] = {
    robot,
    lastUsedAt: null,
    lastSessionId: null,
    lastError: null,
    clearedAt: new Date().toISOString()
  };
  await writeHermesState(state);
}

export async function deleteHermesRobotState(robot: string): Promise<void> {
  const state = await readHermesState();
  delete state.robots[robot];
  await writeHermesState(state);
}

export async function removeHermesRobotOwnedFiles(robot: string): Promise<void> {
  await fs.rm(getHermesRobotHome(robot), { recursive: true, force: true });
}

export function getHermesRobotHome(robot: string): string {
  return path.join(path.dirname(getHermesStatePath()), "hermes", sanitizePathSegment(robot));
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "robot";
}

export function normalizeRobots(robots: HermesRobot[]): HermesRobot[] {
  const migrated = migrateLegacyCronRobots(robots);
  const seen = new Set<string>();
  return migrated.map((robot) => {
    const name = robot.name.trim();
    if (!name) {
      throw new Error("Hermes robot name cannot be empty.");
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate Hermes robot name: ${name}`);
    }
    seen.add(name);
    return {
      name,
      provider: robot.provider.trim(),
      model: robot.model.trim(),
      mode: robot.mode === "ask" ? "ask" : "auto",
      telegram: {
        enabled: Boolean(robot.telegram?.enabled),
        chatId: String(robot.telegram?.chatId ?? "").trim(),
        name: String(robot.telegram?.name ?? "").trim()
      },
      tasks: normalizeTasks(robot.tasks ?? []),
      source: normalizeSource(robot.source),
      createdAt: robot.createdAt || new Date().toISOString(),
      updatedAt: robot.updatedAt || new Date().toISOString()
    };
  });
}

function toUserEditableRobot(robot: HermesRobot): Record<string, unknown> {
  const value: Record<string, unknown> = {
    name: robot.name,
    provider: robot.provider,
    model: robot.model,
    mode: robot.mode
  };
  if (robot.telegram?.enabled || robot.telegram?.chatId || robot.telegram?.name) {
    value.telegram = {
      enabled: Boolean(robot.telegram.enabled),
      chatId: robot.telegram.chatId,
      name: robot.telegram.name
    };
  }
  if (robot.tasks.length) {
    value.tasks = robot.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      type: task.type,
      enabled: task.enabled,
      state: task.state,
      provider: task.provider,
      model: task.model
    }));
  }
  return value;
}

function normalizeRobotShape(value: unknown): HermesRobot {
  const robot = isRecord(value) ? value : {};
  const telegram = isRecord(robot.telegram) ? robot.telegram : {};
  return {
    name: String(robot.name ?? ""),
    provider: String(robot.provider ?? ""),
    model: String(robot.model ?? ""),
    mode: robot.mode === "ask" ? "ask" : "auto",
    telegram: {
      enabled: Boolean(telegram.enabled),
      chatId: String(telegram.chatId ?? ""),
      name: String(telegram.name ?? "")
    },
    tasks: Array.isArray(robot.tasks) ? robot.tasks.map(normalizeTaskShape) : [],
    source: normalizeSource(robot.source),
    createdAt: String(robot.createdAt ?? ""),
    updatedAt: String(robot.updatedAt ?? "")
  };
}

function normalizeTasks(tasks: HermesRobot["tasks"]): HermesRobot["tasks"] {
  const seen = new Set<string>();
  return tasks.map(normalizeTaskShape).filter((task) => {
    const key = task.id || task.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTaskShape(value: unknown): HermesRobot["tasks"][number] {
  const task = isRecord(value) ? value : {};
  return {
    id: String(task.id ?? ""),
    name: String(task.name ?? task.id ?? "task").trim(),
    type: "cron",
    schedule: String(task.schedule ?? ""),
    enabled: Boolean(task.enabled),
    state: String(task.state ?? ""),
    provider: task.provider === undefined || task.provider === null ? "" : String(task.provider),
    model: task.model === undefined || task.model === null ? "" : String(task.model)
  };
}

function migrateLegacyCronRobots(robots: HermesRobot[]): HermesRobot[] {
  const legacyCronRobots = robots.filter((robot) => robot.source?.type === "hermes-cron");
  if (!legacyCronRobots.length) return robots;

  const remaining = robots.filter((robot) => robot.source?.type !== "hermes-cron");
  let target = remaining.find((robot) => robot.source?.type === "hermes-config" || robot.name === "hermes-default");
  if (!target) {
    const first = legacyCronRobots[0]!;
    target = {
      name: "hermes-default",
      provider: first.provider,
      model: first.model,
      mode: first.mode,
      telegram: first.telegram,
      tasks: [],
      source: { type: "hermes-config", id: "default", enabled: true, state: "default" },
      createdAt: first.createdAt,
      updatedAt: new Date().toISOString()
    };
    remaining.unshift(target);
  }

  const legacyTasks = legacyCronRobots.map((robot) => ({
    id: robot.source?.id ?? robot.name,
    name: robot.name,
    type: "cron" as const,
    schedule: robot.source?.schedule ?? "",
    enabled: Boolean(robot.source?.enabled),
    state: robot.source?.state ?? "",
    provider: robot.provider,
    model: robot.model
  }));
  const targetIndex = remaining.findIndex((robot) => robot.name === target!.name);
  remaining[targetIndex] = {
    ...target,
    tasks: normalizeTasks([...(target.tasks ?? []), ...legacyTasks]),
    updatedAt: new Date().toISOString()
  };
  return remaining;
}

function normalizeSource(value: unknown): HermesRobot["source"] {
  if (!isRecord(value)) return undefined;
  const type = value.type === "hermes-config" || value.type === "hermes-cron" || value.type === "manual"
    ? value.type
    : "manual";
  return {
    type,
    id: value.id === undefined ? undefined : String(value.id),
    schedule: value.schedule === undefined ? undefined : String(value.schedule),
    enabled: value.enabled === undefined ? undefined : Boolean(value.enabled),
    state: value.state === undefined ? undefined : String(value.state)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
