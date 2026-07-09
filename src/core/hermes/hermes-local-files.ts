import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../utils/is-record.js";
import type { HermesRobot } from "./hermes-types.js";
import { extractYamlBlock, extractYamlModels, extractYamlValue, stripYamlQuotes } from "./hermes-yaml.js";

export type LocalHermesProviderRecord = {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  apiMode: string;
  models: string[];
  active: boolean;
};

type LocalHermesCronJob = {
  id: string;
  name: string;
  enabled: boolean;
  state: string;
  model: string;
  provider: string;
  schedule: string;
};

export function getLocalHermesDir(): string {
  return process.env.AI_GATEWAY_HERMES_HOME
    ? path.resolve(process.env.AI_GATEWAY_HERMES_HOME)
    : path.join(os.homedir(), ".hermes");
}

export async function writeLocalHermesTelegramBinding(filePath: string, robot: HermesRobot): Promise<void> {
  if (!robot.telegram.enabled || !robot.telegram.chatId) return;
  const raw = await readJsonIfExists(filePath);
  const next: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  const platforms: Record<string, unknown> = isRecord(next.platforms) ? { ...next.platforms } : {};
  const existingTelegram = Array.isArray(platforms.telegram) ? platforms.telegram.filter(isRecord) : [];
  const entry = {
    id: robot.telegram.chatId,
    name: robot.telegram.name || robot.name,
    type: "dm",
    ai_gateway_managed: true,
    ai_gateway_robot: robot.name
  };
  const index = existingTelegram.findIndex((item) => String(item.id ?? "") === robot.telegram.chatId);
  const telegram = index >= 0
    ? existingTelegram.map((item, itemIndex) => (itemIndex === index ? { ...item, ...entry } : item))
    : [...existingTelegram, entry];

  platforms.telegram = telegram;
  next.platforms = platforms;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function writeLocalHermesCronJobs(filePath: string, robot: HermesRobot): Promise<void> {
  if (!robot.tasks.length) return;
  const raw = await readJsonIfExists(filePath);
  const next: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  const taskIds = new Set(robot.tasks.map((task) => task.id).filter(Boolean));
  const existingJobs = Array.isArray(next.jobs)
    ? next.jobs.filter((job) => !isRecord(job) || !taskIds.has(String(job.id ?? "")))
    : [];
  const jobs = [
    ...existingJobs,
    ...robot.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      state: task.state,
      model: task.model || robot.model,
      provider: task.provider || robot.provider,
      schedule_display: task.schedule,
      ai_gateway_managed: true,
      ai_gateway_robot: robot.name
    }))
  ];

  next.jobs = jobs;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function pruneLocalHermesCronJobs(filePath: string, robot: HermesRobot): Promise<void> {
  const raw = await readJsonIfExists(filePath);
  if (!raw) return;
  const next: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  if (!Array.isArray(next.jobs)) return;

  const taskIds = new Set(robot.tasks.map((task) => task.id).filter(Boolean));
  const jobs = next.jobs.filter((job) => {
    if (!isRecord(job)) return true;
    const jobRobot = String(job.ai_gateway_robot ?? "");
    const jobId = String(job.id ?? "");
    return jobRobot !== robot.name && (!jobId || !taskIds.has(jobId));
  });

  next.jobs = jobs;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function pruneNativeHermesAuthStore(authPath: string): Promise<void> {
  const raw = await readJsonIfExists(authPath);
  if (!raw) return;
  const next = isRecord(raw) ? { ...raw } : {};
  next.providers = {};
  next.credential_pool = {};
  next.active_provider = "";
  next.updated_at = new Date().toISOString();
  await fs.writeFile(authPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(authPath, 0o600).catch(() => undefined);
}

export async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function discoverLocalHermesRobots(sourceDir: string): Promise<HermesRobot> {
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

export async function discoverLocalHermesProviders(sourceDir: string): Promise<LocalHermesProviderRecord[]> {
  const raw = await readTextIfExists(path.join(sourceDir, "config.yaml"));
  return parseLocalHermesProviderRecords(raw).providers;
}

export function parseLocalHermesProviderRecords(raw: string): { activeProvider: string; providers: LocalHermesProviderRecord[] } {
  if (!raw.trim()) return { activeProvider: "", providers: [] };

  const modelBlock = extractYamlBlock(raw, "model");
  const activeProvider = extractYamlValue(modelBlock, "provider");
  const activeModel = extractYamlValue(modelBlock, "default");
  const activeBaseUrl = extractYamlValue(modelBlock, "base_url");
  const activeApiKey = extractYamlValue(modelBlock, "api_key");
  const providers = new Map<string, LocalHermesProviderRecord>();

  if (activeProvider) {
    upsertLocalHermesProviderRecord(providers, {
      name: activeProvider,
      baseUrl: activeBaseUrl,
      defaultModel: activeModel,
      apiMode: "",
      models: activeModel ? [activeModel] : [],
      apiKey: activeApiKey,
      active: true
    });
  }

  for (const provider of parseLocalHermesProvidersBlock(extractYamlBlock(raw, "providers"))) {
    upsertLocalHermesProviderRecord(providers, provider);
  }
  for (const provider of parseLocalHermesCustomProvidersBlock(extractYamlBlock(raw, "custom_providers"))) {
    upsertLocalHermesProviderRecord(providers, provider);
  }

  return { activeProvider, providers: [...providers.values()] };
}

export async function readLocalHermesConfig(filePath: string): Promise<{ model: string; provider: string; baseUrl: string }> {
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

function parseLocalHermesProvidersBlock(block: string): LocalHermesProviderRecord[] {
  const providers: LocalHermesProviderRecord[] = [];
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^  (\S.*?):\s*$/);
    if (!match) continue;
    const providerKey = stripYamlQuotes(match[1]!);
    const entryLines: string[] = [];
    index += 1;
    while (index < lines.length && /^    \S/.test(lines[index]!)) {
      entryLines.push(lines[index]!);
      index += 1;
      while (index < lines.length && /^      \S/.test(lines[index]!)) {
        entryLines.push(lines[index]!);
        index += 1;
      }
    }
    index -= 1;

    const entry = entryLines.join("\n");
    const name = extractYamlValue(entry, "name") || providerKey;
    if (!name || name === "{}") continue;
    providers.push({
      name,
      baseUrl: extractYamlValue(entry, "api") || extractYamlValue(entry, "base_url") || extractYamlValue(entry, "url"),
      defaultModel: extractYamlValue(entry, "default_model") || extractYamlValue(entry, "model"),
      apiMode: extractYamlValue(entry, "transport") || extractYamlValue(entry, "api_mode"),
      models: extractYamlModels(entry),
      apiKey: extractYamlValue(entry, "api_key"),
      active: false
    });
  }
  return providers;
}

function parseLocalHermesCustomProvidersBlock(block: string): LocalHermesProviderRecord[] {
  const providers: LocalHermesProviderRecord[] = [];
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const first = lines[index]!.match(/^  -\s*(.*)$/);
    if (!first) continue;
    const entryLines = [first[1] ? `    ${first[1]}` : ""].filter(Boolean);
    index += 1;
    while (index < lines.length && /^    \S/.test(lines[index]!)) {
      entryLines.push(lines[index]!);
      index += 1;
      while (index < lines.length && /^      \S/.test(lines[index]!)) {
        entryLines.push(lines[index]!);
        index += 1;
      }
    }
    index -= 1;

    const entry = entryLines.join("\n");
    const name = extractYamlValue(entry, "name");
    if (!name) continue;
    providers.push({
      name,
      baseUrl: extractYamlValue(entry, "base_url") || extractYamlValue(entry, "api") || extractYamlValue(entry, "url"),
      defaultModel: extractYamlValue(entry, "default_model") || extractYamlValue(entry, "model"),
      apiMode: extractYamlValue(entry, "api_mode") || extractYamlValue(entry, "transport"),
      models: extractYamlModels(entry),
      apiKey: extractYamlValue(entry, "api_key"),
      active: false
    });
  }
  return providers;
}

function upsertLocalHermesProviderRecord(target: Map<string, LocalHermesProviderRecord>, provider: LocalHermesProviderRecord): void {
  const existing = target.get(provider.name);
  if (!existing) {
    target.set(provider.name, {
      ...provider,
      models: [...new Set(provider.models.filter(Boolean))]
    });
    return;
  }

  target.set(provider.name, {
    name: provider.name,
    baseUrl: provider.baseUrl || existing.baseUrl,
    apiKey: provider.apiKey || existing.apiKey,
    defaultModel: provider.defaultModel || existing.defaultModel,
    apiMode: provider.apiMode || existing.apiMode,
    models: [...new Set([...existing.models, ...provider.models].filter(Boolean))],
    active: existing.active || provider.active
  });
}
