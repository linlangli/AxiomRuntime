import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getHermesExportPath } from "../config/paths.js";
import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { writeJsonFile } from "../config/json-store.js";
import { writeLog } from "../logs/log-service.js";
import { getProviderStatuses } from "../status/status-service.js";
import type { Provider } from "../types.js";
import {
  clearHermesRobotState,
  deleteHermesRobotState,
  readHermesRobots,
  readHermesState,
  removeHermesRobotOwnedFiles,
  writeHermesRobots
} from "./hermes-store.js";
import { isHermesInstalled, runHermesRobot } from "./hermes-runner.js";
import type {
  AddHermesRobotInput,
  HermesRobot,
  HermesRobotStatus,
  ImportLocalHermesResult,
  ImportHermesRobotResult,
  UpdateHermesRobotInput
} from "./hermes-types.js";

export async function listHermesRobots(): Promise<HermesRobot[]> {
  return (await readHermesRobots()).robots;
}

export async function getHermesRobot(name: string): Promise<HermesRobot | null> {
  return (await listHermesRobots()).find((robot) => robot.name === name) ?? null;
}

export async function addHermesRobot(input: AddHermesRobotInput): Promise<HermesRobot> {
  const robots = await listHermesRobots();
  const name = input.name.trim();
  if (!name) {
    throw new Error("Hermes robot name cannot be empty.");
  }
  if (robots.some((robot) => robot.name === name)) {
    throw new Error(`Hermes robot already exists: ${name}`);
  }

  const providers = await readProviders();
  if (!providers.some((provider) => provider.name === input.provider)) {
    throw new Error(`Provider not found: ${input.provider}`);
  }

  const now = new Date().toISOString();
  const robot: HermesRobot = {
    name,
    provider: input.provider,
    model: input.model.trim(),
    mode: input.mode ?? "auto",
    telegram: {
      enabled: Boolean(input.telegram?.enabled),
      chatId: input.telegram?.chatId?.trim() ?? "",
      name: input.telegram?.name?.trim() ?? ""
    },
    tasks: [],
    source: { type: "manual" },
    createdAt: now,
    updatedAt: now
  };

  await writeHermesRobots({ robots: [...robots, robot] });
  await writeLog({
    category: "system",
    action: "hermes_robot_add",
    message: `Added Hermes robot ${robot.name}.`,
    metadata: { robot: robot.name, provider: robot.provider, model: robot.model, telegram: robot.telegram.enabled }
  });
  return robot;
}

export async function updateHermesRobot(name: string, patch: UpdateHermesRobotInput): Promise<HermesRobot> {
  const robots = await listHermesRobots();
  const current = robots.find((robot) => robot.name === name);
  if (!current) {
    throw new Error(`Hermes robot not found: ${name}`);
  }

  const nextName = patch.name?.trim() || current.name;
  if (nextName !== current.name && robots.some((robot) => robot.name === nextName)) {
    throw new Error(`Hermes robot already exists: ${nextName}`);
  }

  if (patch.provider) {
    const providers = await readProviders();
    if (!providers.some((provider) => provider.name === patch.provider)) {
      throw new Error(`Provider not found: ${patch.provider}`);
    }
  }

  const updated: HermesRobot = {
    ...current,
    name: nextName,
    provider: patch.provider ?? current.provider,
    model: patch.model ?? current.model,
    mode: patch.mode ?? current.mode,
    telegram: patch.telegram
      ? {
          enabled: Boolean(patch.telegram.enabled),
          chatId: patch.telegram.chatId?.trim() ?? "",
          name: patch.telegram.name?.trim() ?? ""
        }
      : current.telegram,
    updatedAt: new Date().toISOString()
  };

  await writeHermesRobots({
    robots: robots.map((robot) => (robot.name === current.name ? updated : robot))
  });
  await writeLog({
    category: "system",
    action: "hermes_robot_edit",
    message: `Updated Hermes robot ${updated.name}.`,
    metadata: { robot: updated.name, previousName: current.name, provider: updated.provider, model: updated.model }
  });
  return updated;
}

export async function getHermesRobotStatuses(options: { refreshProviders?: boolean } = {}): Promise<HermesRobotStatus[]> {
  const [robots, providerStatuses, cache, state] = await Promise.all([
    listHermesRobots(),
    getProviderStatuses({ refresh: options.refreshProviders }),
    readCache(),
    readHermesState()
  ]);
  const providerByName = new Map(providerStatuses.map((provider) => [provider.name, provider]));
  const hermesCli = isHermesInstalled() ? "installed" : "missing";

  return robots.map((robot) => {
    const provider = providerByName.get(robot.provider);
    const cachedModels = cache.providers[robot.provider]?.models ?? [];
    const notes: string[] = [];
    const providerHealth = provider?.health ?? "missing";
    const modelAvailable = cachedModels.length ? cachedModels.includes(robot.model) : "unknown";
    const telegram = robot.telegram?.enabled && robot.telegram.chatId
      ? "configured"
      : "disabled";

    if (hermesCli === "missing") notes.push("Hermes CLI not installed or not in PATH.");
    if (!provider) notes.push(`Provider missing: ${robot.provider}.`);
    if (provider?.health === "error") notes.push(`Provider health error: ${provider.lastError ?? "unknown error"}.`);
    if (modelAvailable === false) notes.push(`Model not found in cache: ${robot.model}.`);

    const status = notes.some((note) => note.includes("missing") || note.includes("error") || note.includes("not installed"))
      ? "error"
      : notes.length
        ? "warning"
        : "ready";

    return {
      robot,
      status,
      hermesCli,
      providerHealth,
      providerExists: Boolean(provider),
      modelAvailable,
      telegram,
      lastUsedAt: state.robots[robot.name]?.lastUsedAt ?? null,
      lastError: state.robots[robot.name]?.lastError ?? null,
      notes
    };
  });
}

export async function useHermesRobot(name: string): Promise<number> {
  const robot = await getHermesRobot(name);
  if (!robot) {
    throw new Error(`Hermes robot not found: ${name}`);
  }

  const provider = await resolveRobotProvider(robot);
  await writeLog({
    category: "usage",
    action: "hermes_robot_use",
    message: `Using Hermes robot ${robot.name}.`,
    metadata: { robot: robot.name, provider: provider.name, model: robot.model }
  });
  return runHermesRobot(robot, provider);
}

export async function clearHermesRobot(name: string): Promise<void> {
  const robot = await getHermesRobot(name);
  if (!robot) {
    throw new Error(`Hermes robot not found: ${name}`);
  }
  await clearHermesRobotState(name);
  await removeHermesRobotOwnedFiles(name);
  await writeLog({
    category: "system",
    action: "hermes_robot_clear",
    message: `Cleared Hermes robot ${name}.`,
    metadata: { robot: name }
  });
}

export async function deleteHermesRobot(name: string): Promise<void> {
  const robots = await listHermesRobots();
  if (!robots.some((robot) => robot.name === name)) {
    throw new Error(`Hermes robot not found: ${name}`);
  }
  await writeHermesRobots({ robots: robots.filter((robot) => robot.name !== name) });
  await deleteHermesRobotState(name);
  await removeHermesRobotOwnedFiles(name);
  await writeLog({
    category: "system",
    action: "hermes_robot_delete",
    message: `Deleted Hermes robot ${name}.`,
    metadata: { robot: name }
  });
}

export async function exportHermesRobot(name: string, outputPath = getHermesExportPath(name)): Promise<string> {
  const robot = await getHermesRobot(name);
  if (!robot) {
    throw new Error(`Hermes robot not found: ${name}`);
  }
  await writeJsonFile(outputPath, { robot: toPortableRobot(robot), exportedAt: new Date().toISOString(), format: "ai-gateway.hermes-robot.v1" });
  return outputPath;
}

export async function importHermesRobot(
  filePath: string,
  options: { onConflict?: "overwrite" | "rename" | "error"; renameTo?: string } = {}
): Promise<ImportHermesRobotResult> {
  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  const robot = normalizeImport(raw);
  const robots = await listHermesRobots();
  const existing = robots.find((item) => item.name === robot.name);
  let action: ImportHermesRobotResult["action"] = "created";
  let nextRobot = robot;

  if (existing) {
    if (options.onConflict === "overwrite") {
      action = "overwritten";
    } else if (options.onConflict === "rename" && options.renameTo) {
      nextRobot = { ...robot, name: options.renameTo.trim(), updatedAt: new Date().toISOString() };
      action = "renamed";
      if (robots.some((item) => item.name === nextRobot.name)) {
        throw new Error(`Hermes robot already exists: ${nextRobot.name}`);
      }
    } else {
      throw new Error(`Hermes robot already exists: ${robot.name}`);
    }
  }

  const nextRobots = existing && action === "overwritten"
    ? robots.map((item) => (item.name === robot.name ? { ...robot, updatedAt: new Date().toISOString() } : item))
    : [...robots, nextRobot];
  await writeHermesRobots({ robots: nextRobots });
  return { robot: nextRobot, action };
}

export async function importLocalHermesRobots(options: { overwrite?: boolean } = {}): Promise<ImportLocalHermesResult> {
  const sourceDir = getLocalHermesDir();
  const [providers, existingRobots, localRobot] = await Promise.all([
    readProviders(),
    listHermesRobots(),
    discoverLocalHermesRobots(sourceDir)
  ]);
  const now = new Date().toISOString();
  const imported: HermesRobot[] = [];
  const skipped: HermesRobot[] = [];
  const nextRobots = [...existingRobots];

  for (const candidate of [localRobot]) {
    const robot = {
      ...candidate,
      provider: resolveLocalProviderName(candidate.provider, candidate.model, providers),
      tasks: candidate.tasks.map((task) => ({
        ...task,
        provider: resolveLocalProviderName(task.provider || candidate.provider, task.model || candidate.model, providers),
        model: task.model || candidate.model
      })),
      updatedAt: now
    };
    const existingIndex = nextRobots.findIndex((item) => item.name === robot.name);
    if (existingIndex >= 0 && !options.overwrite) {
      skipped.push(robot);
      continue;
    }
    if (existingIndex >= 0) {
      nextRobots[existingIndex] = {
        ...robot,
        createdAt: nextRobots[existingIndex]!.createdAt
      };
    } else {
      nextRobots.push(robot);
    }
    imported.push(robot);
  }

  await writeHermesRobots({ robots: nextRobots });
  await writeLog({
    category: "system",
    action: "hermes_import_local",
    message: `Imported ${imported.length} local Hermes robot(s).`,
    metadata: { imported: imported.length, skipped: skipped.length, sourceDir }
  });
  return { imported, skipped, sourceDir };
}

async function resolveRobotProvider(robot: HermesRobot): Promise<Provider> {
  const provider = (await readProviders()).find((item) => item.name === robot.provider);
  if (!provider) {
    throw new Error(`Provider not found for Hermes robot ${robot.name}: ${robot.provider}`);
  }
  return provider;
}

function normalizeImport(value: unknown): HermesRobot {
  if (containsSecretField(value)) {
    throw new Error("Import file must not contain API keys or secrets.");
  }
  const container = isRecord(value) && isRecord(value.robot) ? value.robot : value;
  if (!isRecord(container)) {
    throw new Error("Invalid Hermes robot import file.");
  }
  const telegram = isRecord(container.telegram) ? container.telegram : {};
  const now = new Date().toISOString();
  return {
    name: String(container.name ?? "").trim(),
    provider: String(container.provider ?? "").trim(),
    model: String(container.model ?? "").trim(),
    mode: container.mode === "ask" ? "ask" : "auto",
    telegram: {
      enabled: Boolean(telegram.enabled),
      chatId: String(telegram.chatId ?? "").trim(),
      name: String(telegram.name ?? "").trim()
    },
    tasks: Array.isArray(container.tasks)
      ? container.tasks.map((task) => {
          const value = isRecord(task) ? task : {};
          return {
            id: String(value.id ?? ""),
            name: String(value.name ?? value.id ?? "task"),
            type: "cron",
            schedule: "",
            enabled: Boolean(value.enabled),
            state: String(value.state ?? ""),
            provider: value.provider === undefined || value.provider === null ? "" : String(value.provider),
            model: value.model === undefined || value.model === null ? "" : String(value.model)
          };
        })
      : [],
    source: undefined,
    createdAt: String(container.createdAt ?? now),
    updatedAt: now
  };
}

function toPortableRobot(robot: HermesRobot): Record<string, unknown> {
  const value: Record<string, unknown> = {
    name: robot.name,
    provider: robot.provider,
    model: robot.model,
    mode: robot.mode
  };
  if (robot.telegram?.enabled || robot.telegram?.chatId || robot.telegram?.name) {
    value.telegram = robot.telegram;
  }
  if (robot.tasks.length) {
    value.tasks = robot.tasks;
  }
  return value;
}

async function discoverLocalHermesRobots(sourceDir: string): Promise<HermesRobot> {
  const [config, telegram, cronJobs] = await Promise.all([
    readLocalHermesConfig(path.join(sourceDir, "config.yaml")),
    readLocalHermesTelegram(path.join(sourceDir, "channel_directory.json")),
    readLocalHermesCronJobs(path.join(sourceDir, "cron", "jobs.json"))
  ]);
  const now = new Date().toISOString();
  const defaultProvider = config.provider || "hermes-local";
  const defaultModel = config.model || "";
  return {
    name: "hermes-default",
    provider: defaultProvider,
    model: defaultModel,
    mode: "auto",
    telegram,
    tasks: cronJobs.map((job) => ({
      id: job.id,
      name: job.name,
      type: "cron",
      schedule: job.schedule,
      enabled: job.enabled,
      state: job.state,
      provider: job.provider || defaultProvider,
      model: job.model || defaultModel
    })),
    source: { type: "hermes-config", id: "default", enabled: true, state: "default" },
    createdAt: now,
    updatedAt: now
  };
}

async function readLocalHermesConfig(filePath: string): Promise<{ model: string; provider: string; baseUrl: string }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const modelBlock = extractYamlBlock(raw, "model");
    return {
      model: extractYamlValue(modelBlock, "default"),
      provider: extractYamlValue(modelBlock, "provider"),
      baseUrl: extractYamlValue(modelBlock, "base_url")
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { model: "", provider: "", baseUrl: "" };
    }
    throw error;
  }
}

async function readLocalHermesTelegram(filePath: string): Promise<HermesRobot["telegram"]> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isRecord(raw) || !isRecord(raw.platforms) || !Array.isArray(raw.platforms.telegram)) {
      return { enabled: false, chatId: "", name: "" };
    }
    const first = raw.platforms.telegram.find(isRecord);
    if (!first) {
      return { enabled: false, chatId: "", name: "" };
    }
    return {
      enabled: true,
      chatId: String(first.id ?? ""),
      name: String(first.name ?? "")
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { enabled: false, chatId: "", name: "" };
    }
    throw error;
  }
}

type LocalHermesCronJob = {
  id: string;
  name: string;
  enabled: boolean;
  state: string;
  model: string;
  provider: string;
  schedule: string;
};

async function readLocalHermesCronJobs(filePath: string): Promise<LocalHermesCronJob[]> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.jobs)) {
      return [];
    }
    return raw.jobs.filter(isRecord).map((job) => ({
      id: String(job.id ?? ""),
      name: String(job.name ?? job.id ?? "hermes-cron"),
      enabled: Boolean(job.enabled),
      state: String(job.state ?? ""),
      model: job.model === null || job.model === undefined ? "" : String(job.model),
      provider: job.provider === null || job.provider === undefined ? "" : String(job.provider),
      schedule: String(job.schedule_display ?? "")
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function resolveLocalProviderName(localProvider: string, model: string, providers: Provider[]): string {
  const exactName = providers.find((provider) => provider.name === localProvider);
  if (exactName) return exactName.name;

  const sameModel = providers.find((provider) => provider.model === model);
  if (sameModel) return sameModel.name;

  const compatibleFamily = providers.find((provider) => {
    const providerModel = provider.model.toLowerCase();
    const target = model.toLowerCase();
    return target.includes("claude") && providerModel.includes("claude")
      || (target.includes("gpt") || target.includes("codex")) && (providerModel.includes("gpt") || providerModel.includes("codex"));
  });
  if (compatibleFamily) return compatibleFamily.name;

  return localProvider || "hermes-local";
}

function extractYamlBlock(raw: string, key: string): string {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) return "";
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

function extractYamlValue(block: string, key: string): string {
  const match = block.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, "m"));
  return stripYamlQuotes(match?.[1] ?? "");
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getLocalHermesDir(): string {
  return process.env.AI_GATEWAY_HERMES_HOME
    ? path.resolve(process.env.AI_GATEWAY_HERMES_HOME)
    : path.join(os.homedir(), ".hermes");
}

function containsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSecretField);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase();
    if (["apikey", "api_key", "token", "secret", "password", "authorization"].includes(normalized)) {
      return true;
    }
    return containsSecretField(child);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
