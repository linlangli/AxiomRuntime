import fs from "node:fs/promises";
import { getHermesAllExportPath, getHermesExportPath } from "../config/paths.js";
import { readCache, upsertProviderCache } from "../config/cache-store.js";
import { readProviders, writeProviders } from "../config/providers-store.js";
import { writeJsonFile } from "../config/json-store.js";
import {
  readArray,
  readBoolean,
  readEnum,
  readNumber,
  readOptionalRecord,
  readRecord,
  readRequiredArray,
  readRequiredString,
  readString
} from "../config/schema.js";
import { recordProviderChange } from "../integrations/integration-state.js";
import { writeLog } from "../logs/log-service.js";
import type { Provider, ProviderCache } from "../types.js";
import { isRecord } from "../utils/is-record.js";
import { readHermesRobots, writeHermesRobots } from "./hermes-store.js";
import type { HermesRobot, ImportHermesRobotResult, ImportLocalHermesResult } from "./hermes-types.js";
import {
  discoverLocalHermesProviders,
  discoverLocalHermesRobots,
  getLocalHermesDir,
  type LocalHermesProviderRecord
} from "./hermes-local-files.js";

type HermesImportBundle = {
  robots: HermesRobot[];
  providers: Provider[];
  providerCache: Record<string, ProviderCache>;
};

export async function exportHermesRobot(name?: string, outputPath = name ? getHermesExportPath(name) : getHermesAllExportPath()): Promise<string> {
  const robots = (await readHermesRobots()).robots;
  const exportedRobots = name ? robots.filter((robot) => robot.name === name) : robots;
  if (name && !exportedRobots.length) {
    throw new Error(`Hermes robot not found: ${name}`);
  }
  if (!exportedRobots.length) {
    throw new Error("No Hermes robots configured. Run `ai hermes add` first.");
  }
  const providers = await readProviders();
  const cache = await readCache();
  const providerNames = getHermesRobotProviderNames(exportedRobots);
  const exportedProviders = providers.filter((provider) => providerNames.has(provider.name));
  const providerCache = Object.fromEntries(
    exportedProviders
      .map((provider) => [provider.name, cache.providers[provider.name]])
      .filter((entry): entry is [string, ProviderCache] => Boolean(entry[1]))
  );

  await writeJsonFile(outputPath, {
    robots: exportedRobots.map(toPortableRobot),
    providers: exportedProviders,
    providerCache,
    exportedAt: new Date().toISOString(),
    format: "ai-gateway.hermes-robots.v2"
  });
  return outputPath;
}

export async function importHermesRobot(
  filePath: string,
  options: { onConflict?: "overwrite" | "rename" | "error"; renameTo?: string } = {}
): Promise<ImportHermesRobotResult> {
  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  const bundle = normalizeHermesImport(raw);
  const importedRobotResults: ImportHermesRobotResult["robots"] = [];
  const robots = (await readHermesRobots()).robots;
  const nextRobots = [...robots];

  for (const robot of bundle.robots) {
    const existingIndex = nextRobots.findIndex((item) => item.name === robot.name);
    let action: ImportHermesRobotResult["robots"][number]["action"] = "created";
    let nextRobot = robot;

    if (existingIndex >= 0) {
      if (options.onConflict === "overwrite") {
        action = "overwritten";
        nextRobot = { ...robot, createdAt: nextRobots[existingIndex]!.createdAt, updatedAt: new Date().toISOString() };
      } else if (options.onConflict === "rename" && options.renameTo && bundle.robots.length === 1) {
        nextRobot = { ...robot, name: options.renameTo.trim(), updatedAt: new Date().toISOString() };
        action = "renamed";
        if (nextRobots.some((item) => item.name === nextRobot.name)) {
          throw new Error(`Hermes robot already exists: ${nextRobot.name}`);
        }
      } else if (options.onConflict === "rename") {
        throw new Error("Rename is only supported when importing one Hermes robot.");
      } else {
        throw new Error(`Hermes robot already exists: ${robot.name}`);
      }
    }

    if (existingIndex >= 0 && action === "overwritten") {
      nextRobots[existingIndex] = nextRobot;
    } else {
      nextRobots.push(nextRobot);
    }
    importedRobotResults.push({ robot: nextRobot, action });
  }

  const importedProviders = await importHermesBundleProviders(bundle.providers, bundle.providerCache);
  await writeHermesRobots({ robots: nextRobots });
  return { robots: importedRobotResults, importedProviders };
}

export async function importLocalHermesRobots(options: { overwrite?: boolean } = {}): Promise<ImportLocalHermesResult> {
  const sourceDir = getLocalHermesDir();
  const [existingProviders, existingRobots, localRobot, localProviders] = await Promise.all([
    readProviders(),
    readHermesRobots().then((file) => file.robots),
    discoverLocalHermesRobots(sourceDir),
    discoverLocalHermesProviders(sourceDir)
  ]);
  const { providers, importedProviders, skippedProviders } = await importLocalHermesProviders(existingProviders, localProviders, options);
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
    const existingIndex = findExistingLocalHermesRobotIndex(nextRobots, robot);
    if (existingIndex >= 0 && !options.overwrite) {
      skipped.push(nextRobots[existingIndex]!);
      continue;
    }
    if (existingIndex >= 0) {
      const existing = nextRobots[existingIndex]!;
      nextRobots[existingIndex] = {
        ...robot,
        name: existing.name,
        createdAt: existing.createdAt
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
    metadata: {
      imported: imported.length,
      skipped: skipped.length,
      importedProviders: importedProviders.map((provider) => provider.name),
      skippedProviders: skippedProviders.map((provider) => provider.name),
      sourceDir
    }
  });
  return { imported, skipped, importedProviders, skippedProviders, sourceDir };
}

function normalizeHermesImport(value: unknown): HermesImportBundle {
  if (!isHermesRobotBundle(value) && containsSecretField(value)) {
    throw new Error("Legacy Hermes robot import files must not contain API keys or secrets.");
  }
  const container = isRecord(value) && isRecord(value.robot) ? value.robot : value;
  const providers = isRecord(value) && value.providers !== undefined
    ? readRequiredArray(value.providers, "providers").map((provider, index) => normalizeBundleProvider(provider, `providers[${index}]`))
    : [];
  const providerCache = isRecord(value) && value.providerCache !== undefined
    ? normalizeBundleProviderCache(readRecord(value.providerCache, "providerCache"))
    : {};

  return {
    robots: normalizeImportedRobots(container),
    providers,
    providerCache
  };
}

function normalizeImportedRobots(value: unknown): HermesRobot[] {
  const rawRobots = isRecord(value) && value.robots !== undefined
    ? readRequiredArray(value.robots, "robots")
    : Array.isArray(value)
      ? value
      : [value];
  const robots = rawRobots.map((robot, index) => normalizeImportedRobot(robot, `robots[${index}]`));
  if (!robots.length) {
    throw new Error("Invalid Hermes robot import file.");
  }
  const names = new Set<string>();
  for (const robot of robots) {
    if (!robot.name) {
      throw new Error("Hermes robot name cannot be empty.");
    }
    if (names.has(robot.name)) {
      throw new Error(`Duplicate Hermes robot name in import file: ${robot.name}`);
    }
    names.add(robot.name);
  }
  return robots;
}

function normalizeImportedRobot(value: unknown, path = "robot"): HermesRobot {
  const container = isRecord(value) && isRecord(value.robot) ? value.robot : value;
  const robot = readRecord(container, path);
  const telegram = readOptionalRecord(robot.telegram, `${path}.telegram`) ?? {};
  const tasks = robot.tasks === undefined
    ? []
    : readRequiredArray(robot.tasks, `${path}.tasks`).map((task, index) => normalizeImportedTask(task, `${path}.tasks[${index}]`));
  const now = new Date().toISOString();
  return {
    name: readRequiredString(robot, "name", `${path}.name`),
    provider: readRequiredString(robot, "provider", `${path}.provider`),
    model: readRequiredString(robot, "model", `${path}.model`),
    mode: readEnum(robot, "mode", ["ask", "auto"] as const, "auto"),
    telegram: {
      enabled: readBoolean(telegram.enabled),
      chatId: readString(telegram, "chatId"),
      name: readString(telegram, "name")
    },
    tasks,
    source: undefined,
    createdAt: readString(robot, "createdAt", { fallback: now }),
    updatedAt: now
  };
}

function normalizeImportedTask(value: unknown, path: string): HermesRobot["tasks"][number] {
  const task = readRecord(value, path);
  const id = readString(task, "id");
  return {
    id,
    name: readString(task, "name", { fallback: id || "task" }) || "task",
    type: "cron",
    schedule: readString(task, "schedule"),
    enabled: readBoolean(task.enabled),
    state: readString(task, "state"),
    provider: readString(task, "provider"),
    model: readString(task, "model")
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
    value.tasks = robot.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      type: task.type,
      schedule: task.schedule,
      enabled: task.enabled,
      state: task.state,
      provider: task.provider,
      model: task.model
    }));
  }
  if (robot.source) {
    value.source = robot.source;
  }
  if (robot.createdAt) {
    value.createdAt = robot.createdAt;
  }
  if (robot.updatedAt) {
    value.updatedAt = robot.updatedAt;
  }
  return value;
}

function isHermesRobotBundle(value: unknown): boolean {
  return isRecord(value)
    && typeof value.format === "string"
    && (value.format.startsWith("ai-gateway.hermes-robot.") || value.format.startsWith("ai-gateway.hermes-robots."))
    && Array.isArray(value.providers);
}

function normalizeBundleProvider(value: unknown, path: string): Provider {
  const provider = readRecord(value, path);
  return {
    name: readRequiredString(provider, "name", `${path}.name`),
    baseUrl: readRequiredString(provider, "baseUrl", `${path}.baseUrl`).replace(/\/+$/, ""),
    apiKey: readRequiredString(provider, "apiKey", `${path}.apiKey`),
    mode: readEnum(provider, "mode", ["ask", "auto"] as const, "auto"),
    level: readNumber(provider, "level", Number.MAX_SAFE_INTEGER),
    model: readString(provider, "model")
  };
}

function normalizeBundleProviderCache(value: Record<string, unknown>): Record<string, ProviderCache> {
  const result: Record<string, ProviderCache> = {};
  for (const [name, raw] of Object.entries(value)) {
    const cache = readRecord(raw, `providerCache.${name}`);
    result[name] = {
      status: readEnum(cache, "status", ["ok", "error", "unknown"] as const, "unknown"),
      models: readArray(cache.models).map((model) => String(model)).filter(Boolean),
      lastCheckedAt: cache.lastCheckedAt === null || cache.lastCheckedAt === undefined ? null : String(cache.lastCheckedAt),
      lastError: cache.lastError === null || cache.lastError === undefined ? null : String(cache.lastError)
    };
  }
  return result;
}

function getHermesRobotProviderNames(robots: HermesRobot[]): Set<string> {
  return new Set(robots.flatMap((robot) => [
    robot.provider,
    ...robot.tasks.map((task) => task.provider)
  ]).filter(Boolean));
}

async function importHermesBundleProviders(
  incomingProviders: Provider[],
  incomingCache: Record<string, ProviderCache>
): Promise<Provider[]> {
  if (!incomingProviders.length) return [];
  const current = await readProviders();
  const incomingNames = new Set(incomingProviders.map((provider) => provider.name).filter(Boolean));
  const nextProviders = [
    ...current.filter((provider) => !incomingNames.has(provider.name)),
    ...incomingProviders.filter((provider) => provider.name)
  ];
  await writeProviders(nextProviders);
  const normalizedProviders = await readProviders();
  const imported = normalizedProviders.filter((provider) => incomingNames.has(provider.name));

  for (const provider of imported) {
    const providerCache = incomingCache[provider.name];
    if (providerCache) {
      await upsertProviderCache(provider.name, providerCache);
    }
    await recordProviderChange({
      type: current.some((item) => item.name === provider.name) ? "updated" : "added",
      provider: provider.name
    });
  }

  return imported;
}

async function importLocalHermesProviders(
  existingProviders: Provider[],
  localProviders: LocalHermesProviderRecord[],
  options: { overwrite?: boolean }
): Promise<{ providers: Provider[]; importedProviders: Provider[]; skippedProviders: Provider[] }> {
  const importedProviders: Provider[] = [];
  const skippedProviders: Provider[] = [];
  const providerChanges: Array<{ type: "added" | "updated"; provider: string }> = [];
  let nextProviders = [...existingProviders];

  for (const local of localProviders) {
    if (!local.name || (!local.baseUrl && !local.apiKey && !local.defaultModel)) continue;
    const provider: Provider = {
      name: local.name,
      baseUrl: local.baseUrl,
      apiKey: local.apiKey,
      mode: "auto",
      level: nextProviders.length + 1,
      model: local.defaultModel || local.models[0] || ""
    };
    const existingIndex = nextProviders.findIndex((item) => item.name === provider.name);
    if (existingIndex >= 0 && !options.overwrite) {
      skippedProviders.push(nextProviders[existingIndex]!);
      continue;
    }
    if (existingIndex >= 0) {
      nextProviders[existingIndex] = { ...provider, level: nextProviders[existingIndex]!.level };
      providerChanges.push({ type: "updated", provider: provider.name });
    } else {
      nextProviders.push(provider);
      providerChanges.push({ type: "added", provider: provider.name });
    }
    importedProviders.push(provider);
  }

  if (importedProviders.length) {
    await writeProviders(nextProviders);
    nextProviders = await readProviders();
    for (const change of providerChanges) {
      await recordProviderChange(change);
    }
    for (const provider of importedProviders) {
      const normalized = nextProviders.find((item) => item.name === provider.name) ?? provider;
      await upsertProviderCache(normalized.name, {
        status: "unknown",
        models: localProviders.find((local) => local.name === normalized.name)?.models ?? [],
        lastCheckedAt: null,
        lastError: null
      });
    }
  }

  return { providers: nextProviders, importedProviders, skippedProviders };
}

function findExistingLocalHermesRobotIndex(robots: HermesRobot[], candidate: HermesRobot): number {
  return robots.findIndex((robot) => isSameLocalHermesRobot(robot, candidate));
}

function isSameLocalHermesRobot(robot: HermesRobot, candidate: HermesRobot): boolean {
  if (robot.name === candidate.name) return true;
  if (robot.source?.type === "hermes-config" && robot.source.id === candidate.source?.id) return true;

  const robotChatId = robot.telegram?.chatId?.trim();
  const candidateChatId = candidate.telegram?.chatId?.trim();
  if (robotChatId && candidateChatId && robotChatId === candidateChatId) return true;

  const robotTaskIds = new Set(robot.tasks.map((task) => task.id).filter(Boolean));
  const candidateTaskIds = candidate.tasks.map((task) => task.id).filter(Boolean);
  if (candidateTaskIds.length && candidateTaskIds.some((id) => robotTaskIds.has(id))) return true;

  return false;
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
