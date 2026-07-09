import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { hasPendingHermesProviderChanges, markHermesProvidersSynced } from "../integrations/integration-state.js";
import { writeLog } from "../logs/log-service.js";
import { refreshAllProviders } from "../providers/provider-service.js";
import { getSecretFingerprint } from "../runner/tool-runner.js";
import { getProviderStatuses } from "../status/status-service.js";
import type { Provider, ProviderCache } from "../types.js";
import {
  clearHermesRobotState,
  deleteHermesRobotState,
  readHermesRobots,
  readHermesState,
  removeHermesRobotOwnedFiles,
  writeHermesRobots
} from "./hermes-store.js";
import { isHermesInstalled, runHermesRobot } from "./hermes-runner.js";
import { ensureLocalHermesModelListSupport, type HermesModelListPatchResult } from "./hermes-compat.js";
import {
  applyPendingProviderRenamesToHermesRobots,
  switchRobotsWithMissingProvidersToFallback
} from "./hermes-provider-sync.js";
import {
  buildHermesCustomProvidersBlock,
  buildHermesProvidersBlock,
  buildLocalHermesConfig,
  buildLocalHermesEnv,
  getHermesProviderBaseUrl,
  getProviderApiMode,
  getProviderDefaultBaseUrl,
  reconcileLocalHermesModelBlock,
  replaceTopLevelYamlBlock
} from "./hermes-yaml.js";
import {
  getLocalHermesDir,
  parseLocalHermesProviderRecords,
  pruneLocalHermesCronJobs,
  pruneNativeHermesAuthStore,
  readLocalHermesConfig,
  readTextIfExists,
  writeLocalHermesCronJobs,
  writeLocalHermesTelegramBinding
} from "./hermes-local-files.js";
import type {
  AddHermesRobotInput,
  HermesConfiguredProvider,
  HermesConfiguredProvidersResult,
  HermesRobot,
  HermesRobotStatus,
  UpdateHermesRobotInput
} from "./hermes-types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HERMES_LAUNCHD_LABEL = "ai.hermes.gateway";

export async function listHermesRobots(): Promise<HermesRobot[]> {
  return (await readHermesRobots()).robots;
}

export async function listHermesConfiguredProviders(): Promise<HermesConfiguredProvidersResult> {
  const [providers, cache] = await Promise.all([
    readProviders(),
    readCache()
  ]);
  const configPath = path.join(getLocalHermesDir(), "config.yaml");
  const raw = await readTextIfExists(configPath);
  const local = parseLocalHermesProviderRecords(raw);
  const merged = new Map<string, HermesConfiguredProvider>();

  for (const provider of providers) {
    upsertHermesConfiguredProvider(merged, {
      name: provider.name,
      sources: ["ai-gateway"],
      baseUrl: getProviderDefaultBaseUrl(provider),
      defaultModel: provider.model,
      apiMode: getProviderApiMode(provider),
      models: cache.providers[provider.name]?.models ?? [],
      apiKeyConfigured: Boolean(provider.apiKey),
      active: local.activeProvider === provider.name
    });
  }

  for (const provider of local.providers) {
    upsertHermesConfiguredProvider(merged, {
      name: provider.name,
      sources: ["local-hermes"],
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      apiMode: provider.apiMode,
      models: provider.models,
      apiKeyConfigured: Boolean(provider.apiKey),
      active: provider.active || local.activeProvider === provider.name
    });
  }

  return {
    configPath,
    providers: [...merged.values()].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
  };
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

export async function switchHermesRobotsProvider(from: string, to: Provider): Promise<number> {
  const robots = await listHermesRobots();
  const affected = robots.filter((robot) => robot.provider === from);
  for (const robot of affected) {
    await updateHermesRobot(robot.name, { provider: to.name, model: to.model || robot.model });
  }
  return affected.length;
}

type HermesSyncMetadata = {
  providers: string[];
  modelCounts: Record<string, number>;
  hermesModelListPatch: HermesModelListPatchResult;
};

export type HermesRepairResult = {
  configPath: string;
  envPath: string;
  robot: HermesRobot | null;
  provider: Provider | null;
  robotUpdated: boolean;
  configUpdated: boolean;
  envUpdated: boolean;
  hermesModelListPatch: HermesModelListPatchResult;
  restart: { restarted: boolean; method: string; message: string } | null;
};

type HermesRepairOptions = {
  syncCachedModels?: boolean;
};

export async function syncHermesRobotToLocalConfig(name: string): Promise<{
  robot: HermesRobot;
  provider: Provider;
  configPath: string;
  envPath: string;
  metadata: HermesSyncMetadata;
}> {
  const robot = await getHermesRobot(name);
  if (!robot) {
    throw new Error(`Hermes robot not found: ${name}`);
  }
  await refreshAllProviders({ verifyCallableModels: true });
  const providers = await readProviders();
  const provider = resolveProviderFromList(robot, providers);
  const cache = await readCache();
  const providerModels = getProviderModelsFromCache(providers, cache.providers);
  const hermesDir = getLocalHermesDir();
  const configPath = path.join(hermesDir, "config.yaml");
  const envPath = path.join(hermesDir, ".env");
  const authPath = path.join(hermesDir, "auth.json");
  const telegramPath = path.join(hermesDir, "channel_directory.json");
  const cronJobsPath = path.join(hermesDir, "cron", "jobs.json");
  const nextConfig = buildLocalHermesConfig(await readTextIfExists(configPath), robot, provider, providers, providerModels);
  const nextEnv = buildLocalHermesEnv(await readTextIfExists(envPath));
  const hermesModelListPatch = await ensureLocalHermesModelListSupport();
  const metadata = buildHermesSyncMetadata(providers, providerModels, hermesModelListPatch);

  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, nextConfig, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(envPath, nextEnv, { encoding: "utf8", mode: 0o600 });
  await writeLocalHermesTelegramBinding(telegramPath, robot);
  await writeLocalHermesCronJobs(cronJobsPath, robot);
  await pruneNativeHermesAuthStore(authPath);
  await fs.chmod(configPath, 0o600).catch(() => undefined);
  await fs.chmod(envPath, 0o600).catch(() => undefined);
  await writeLog({
    category: "system",
    action: "hermes_sync_local_config",
    message: `Synced Hermes robot ${robot.name} to local Hermes config.`,
    metadata: {
      robot: robot.name,
      provider: provider.name,
      model: robot.model,
      configPath,
      envPath,
      baseUrl: getHermesProviderBaseUrl(robot, provider),
      providers: metadata.providers,
      modelCounts: metadata.modelCounts,
      hermesModelListPatch: metadata.hermesModelListPatch,
      apiKeyFingerprint: getSecretFingerprint(provider.apiKey)
    }
  });
  await markHermesProvidersSynced();
  return { robot, provider, configPath, envPath, metadata };
}

export async function syncHermesProvidersToLocalConfig(): Promise<{ configPath: string; envPath: string; metadata: HermesSyncMetadata }> {
  await refreshAllProviders({ verifyCallableModels: true });
  const providers = await readProviders();
  const cache = await readCache();
  const providerModels = getProviderModelsFromCache(providers, cache.providers);
  const hermesDir = getLocalHermesDir();
  const configPath = path.join(hermesDir, "config.yaml");
  const envPath = path.join(hermesDir, ".env");
  const authPath = path.join(hermesDir, "auth.json");
  const existing = await readTextIfExists(configPath);
  const withModel = reconcileLocalHermesModelBlock(existing, providers);
  const withProviders = replaceTopLevelYamlBlock(withModel, "providers", buildHermesProvidersBlock(providers, providerModels));
  const nextConfig = replaceTopLevelYamlBlock(withProviders, "custom_providers", buildHermesCustomProvidersBlock(providers, providerModels));
  const nextEnv = buildLocalHermesEnv(await readTextIfExists(envPath));
  const hermesModelListPatch = await ensureLocalHermesModelListSupport();
  const metadata = buildHermesSyncMetadata(providers, providerModels, hermesModelListPatch);

  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, nextConfig, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(envPath, nextEnv, { encoding: "utf8", mode: 0o600 });
  await pruneNativeHermesAuthStore(authPath);
  await fs.chmod(configPath, 0o600).catch(() => undefined);
  await fs.chmod(envPath, 0o600).catch(() => undefined);
  await writeLog({
    category: "system",
    action: "hermes_sync_providers",
    message: "Synced AI Gateway providers to local Hermes config.",
    metadata: {
      configPath,
      envPath,
      providers: metadata.providers,
      modelCounts: metadata.modelCounts,
      hermesModelListPatch: metadata.hermesModelListPatch
    }
  });
  await markHermesProvidersSynced();
  return { configPath, envPath, metadata };
}

export async function repairLocalHermesIntegration(options: HermesRepairOptions = {}): Promise<HermesRepairResult> {
  const [storedRobots, providers, cache] = await Promise.all([
    listHermesRobots(),
    readProviders(),
    readCache()
  ]);
  const hermesDir = getLocalHermesDir();
  const configPath = path.join(hermesDir, "config.yaml");
  const envPath = path.join(hermesDir, ".env");
  const authPath = path.join(hermesDir, "auth.json");
  const telegramPath = path.join(hermesDir, "channel_directory.json");
  const cronJobsPath = path.join(hermesDir, "cron", "jobs.json");
  const hermesModelListPatch = await ensureLocalHermesModelListSupport();
  const localModel = await readLocalHermesConfig(configPath);
  const adoption = await adoptLocalHermesModel(storedRobots, localModel, providers);
  const robots = adoption.robots;
  const robot = selectLocalHermesRepairRobot(robots, localModel.provider, providers);
  const provider = robot ? resolveProviderFromList(robot, providers) : null;
  let configUpdated = false;
  let envUpdated = false;

  if (robot && provider) {
    const [existingConfig, existingEnv] = await Promise.all([
      readTextIfExists(configPath),
      readTextIfExists(envPath)
    ]);
    const providerModels = getProviderModelsForRepair(providers, cache.providers, existingConfig, Boolean(options.syncCachedModels));
    const nextConfig = buildLocalHermesConfig(existingConfig, robot, provider, providers, providerModels);
    const nextEnv = buildLocalHermesEnv(existingEnv);

    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    if (nextConfig !== existingConfig) {
      await fs.writeFile(configPath, nextConfig, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(configPath, 0o600).catch(() => undefined);
      configUpdated = true;
    }
    if (nextEnv !== existingEnv) {
      await fs.writeFile(envPath, nextEnv, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(envPath, 0o600).catch(() => undefined);
      envUpdated = true;
    }
    await writeLocalHermesTelegramBinding(telegramPath, robot);
    await writeLocalHermesCronJobs(cronJobsPath, robot);
    await pruneNativeHermesAuthStore(authPath);
  }

  const shouldRestart = hermesModelListPatch.status === "patched" || configUpdated || envUpdated;
  const restart = shouldRestart ? await restartLocalHermesGateway() : null;
  await writeLog({
    category: "system",
    action: "hermes_self_repair",
    message: shouldRestart
      ? "Repaired local Hermes integration."
      : "Checked local Hermes integration.",
    metadata: {
      configPath,
      envPath,
      robot: robot?.name ?? null,
      provider: provider?.name ?? null,
      robotUpdated: adoption.updated,
      configUpdated,
      envUpdated,
      hermesModelListPatch,
      restarted: restart?.restarted ?? false,
      restartMethod: restart?.method ?? null
    }
  });

  return { configPath, envPath, robot, provider, robotUpdated: adoption.updated, configUpdated, envUpdated, hermesModelListPatch, restart };
}

export async function restartLocalHermesGateway(): Promise<{ restarted: boolean; method: string; message: string }> {
  if (process.env.AI_GATEWAY_SKIP_HERMES_RESTART === "1") {
    return { restarted: false, method: "skipped", message: "Hermes gateway restart skipped by AI_GATEWAY_SKIP_HERMES_RESTART." };
  }

  const launchd = await restartHermesLaunchdGateway();
  if (launchd.restarted) return launchd;

  const cli = await restartHermesCliGateway();
  const result = cli.restarted ? cli : {
    restarted: false,
    method: "none",
    message: `Unable to restart Hermes gateway automatically. ${launchd.message} ${cli.message}`.trim()
  };

  await writeLog({
    level: result.restarted ? "info" : "warn",
    category: "system",
    action: "hermes_gateway_restart",
    message: result.message,
    metadata: { restarted: result.restarted, method: result.method }
  });
  return result;
}

export async function syncHermesRobotToLocalConfigAndRestart(name: string): Promise<{
  robot: HermesRobot;
  provider: Provider;
  configPath: string;
  envPath: string;
  metadata: HermesSyncMetadata;
  restart: { restarted: boolean; method: string; message: string };
}> {
  const synced = await syncHermesRobotToLocalConfig(name);
  const restart = await restartLocalHermesGateway();
  return { ...synced, restart };
}

export async function syncHermesProvidersToLocalConfigAndRestart(): Promise<{
  configPath: string;
  envPath: string;
  metadata: HermesSyncMetadata;
  restart: { restarted: boolean; method: string; message: string };
}> {
  const synced = await syncHermesProvidersToLocalConfig();
  const restart = await restartLocalHermesGateway();
  return { ...synced, restart };
}

export async function ensureHermesProviderSync(options: { restart?: boolean; activeRobotName?: string } = {}): Promise<{
  changed: boolean;
  renamedRobots: number;
  switchedRobots: number;
  sync: HermesProviderSyncResult | null;
}> {
  if (!await hasPendingHermesProviderChanges()) {
    return { changed: false, renamedRobots: 0, switchedRobots: 0, sync: null };
  }

  const renamedRobots = await applyPendingProviderRenamesToHermesRobots(switchHermesRobotsProvider);
  const switchedRobots = await switchRobotsWithMissingProvidersToFallback(listHermesRobots, updateHermesRobot);
  const robotName = options.activeRobotName ?? (await listHermesRobots())[0]?.name;
  const sync = options.restart === false
    ? robotName
      ? await syncHermesRobotToLocalConfig(robotName)
      : await syncHermesProvidersToLocalConfig()
    : robotName
      ? await syncHermesRobotToLocalConfigAndRestart(robotName)
      : await syncHermesProvidersToLocalConfigAndRestart();
  return { changed: true, renamedRobots, switchedRobots, sync };
}

type HermesProviderSyncResult =
  | Awaited<ReturnType<typeof syncHermesRobotToLocalConfig>>
  | Awaited<ReturnType<typeof syncHermesRobotToLocalConfigAndRestart>>
  | Awaited<ReturnType<typeof syncHermesProvidersToLocalConfig>>
  | Awaited<ReturnType<typeof syncHermesProvidersToLocalConfigAndRestart>>;

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
  const robots = await listHermesRobots();
  const robot = robots.find((item) => item.name === name);
  if (!robot) {
    throw new Error(`Hermes robot not found: ${name}`);
  }
  await writeHermesRobots({
    robots: robots.map((item) => item.name === name ? { ...item, tasks: [], updatedAt: new Date().toISOString() } : item)
  });
  await pruneLocalHermesCronJobs(path.join(getLocalHermesDir(), "cron", "jobs.json"), robot);
  await clearHermesRobotState(name);
  await removeHermesRobotOwnedFiles(name);
  await writeLog({
    category: "system",
    action: "hermes_robot_clear",
    message: `Cleared Hermes robot ${name}.`,
    metadata: { robot: name, clearedTasks: robot.tasks.length }
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

async function resolveRobotProvider(robot: HermesRobot): Promise<Provider> {
  const provider = (await readProviders()).find((item) => item.name === robot.provider);
  if (!provider) {
    throw new Error(`Provider not found for Hermes robot ${robot.name}: ${robot.provider}`);
  }
  return provider;
}

function resolveProviderFromList(robot: HermesRobot, providers: Provider[]): Provider {
  const provider = providers.find((item) => item.name === robot.provider);
  if (!provider) {
    throw new Error(`Provider not found for Hermes robot ${robot.name}: ${robot.provider}`);
  }
  return provider;
}

function getProviderModelsFromCache(providers: Provider[], cache: Record<string, ProviderCache>): Record<string, string[]> {
  return Object.fromEntries(
    providers.map((provider) => [
      provider.name,
      cache[provider.name]?.models ?? []
    ])
  );
}

function getProviderModelsForRepair(
  providers: Provider[],
  cache: Record<string, ProviderCache>,
  existingConfig: string,
  syncCachedModels: boolean
): Record<string, string[]> {
  if (syncCachedModels) return getProviderModelsFromCache(providers, cache);
  const localProviders = parseLocalHermesProviderRecords(existingConfig).providers;
  const localModels = new Map(localProviders.map((provider) => [provider.name, provider.models]));
  return Object.fromEntries(
    providers.map((provider) => [
      provider.name,
      localModels.get(provider.name) ?? cache[provider.name]?.models ?? []
    ])
  );
}

async function adoptLocalHermesModel(
  robots: HermesRobot[],
  localModel: { model: string; provider: string; baseUrl: string },
  providers: Provider[]
): Promise<{ robots: HermesRobot[]; updated: boolean }> {
  if (!robots.length || !localModel.provider || !localModel.model) {
    return { robots, updated: false };
  }
  if (!providers.some((provider) => provider.name === localModel.provider)) {
    return { robots, updated: false };
  }

  const target = robots.find((robot) => robot.provider === localModel.provider)
    ?? robots.find((robot) => robot.telegram.enabled && robot.telegram.chatId)
    ?? robots[0]!;
  if (target.provider === localModel.provider && target.model === localModel.model) {
    return { robots, updated: false };
  }

  const updatedRobot: HermesRobot = {
    ...target,
    provider: localModel.provider,
    model: localModel.model,
    updatedAt: new Date().toISOString()
  };
  const nextRobots = robots.map((robot) => (robot.name === target.name ? updatedRobot : robot));
  await writeHermesRobots({ robots: nextRobots });
  await writeLog({
    category: "system",
    action: "hermes_robot_adopt_local_model",
    message: `Updated Hermes robot ${target.name} from local Hermes default model.`,
    metadata: {
      robot: target.name,
      provider: localModel.provider,
      model: localModel.model,
      baseUrl: localModel.baseUrl
    }
  });
  return { robots: nextRobots, updated: true };
}

function selectLocalHermesRepairRobot(robots: HermesRobot[], activeProviderName: string, providers: Provider[]): HermesRobot | null {
  if (!robots.length || !providers.length) return null;
  const providerNames = new Set(providers.map((provider) => provider.name));
  const validRobots = robots.filter((robot) => providerNames.has(robot.provider));
  if (!validRobots.length) return null;
  return validRobots.find((robot) => robot.provider === activeProviderName)
    ?? validRobots.find((robot) => robot.telegram.enabled && robot.telegram.chatId)
    ?? validRobots[0]!;
}

function buildHermesSyncMetadata(
  providers: Provider[],
  providerModels: Record<string, string[]>,
  hermesModelListPatch: HermesModelListPatchResult
): HermesSyncMetadata {
  return {
    providers: providers.map((provider) => provider.name),
    modelCounts: Object.fromEntries(providers.map((provider) => [provider.name, providerModels[provider.name]?.length ?? 0])),
    hermesModelListPatch
  };
}

async function restartHermesLaunchdGateway(): Promise<{ restarted: boolean; method: string; message: string }> {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    return { restarted: false, method: "launchd", message: "launchd is not available on this platform." };
  }

  const label = process.env.AI_GATEWAY_HERMES_LAUNCHD_LABEL || DEFAULT_HERMES_LAUNCHD_LABEL;
  const service = `gui/${process.getuid()}/${label}`;
  try {
    await execFileAsync("launchctl", ["print", service], { timeout: 5000 });
    await execFileAsync("launchctl", ["kickstart", "-k", service], { timeout: 10000 });
    const result = { restarted: true, method: "launchd", message: `Restarted Hermes gateway service: ${service}` };
    await writeLog({
      category: "system",
      action: "hermes_gateway_restart",
      message: result.message,
      metadata: { restarted: true, method: result.method, service }
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { restarted: false, method: "launchd", message: `launchd restart failed for ${service}: ${message}` };
  }
}

async function restartHermesCliGateway(): Promise<{ restarted: boolean; method: string; message: string }> {
  try {
    await execFileAsync("hermes", ["gateway", "restart"], { timeout: 20000 });
    const result = { restarted: true, method: "hermes-cli", message: "Restarted Hermes gateway with `hermes gateway restart`." };
    await writeLog({
      category: "system",
      action: "hermes_gateway_restart",
      message: result.message,
      metadata: { restarted: true, method: result.method }
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { restarted: false, method: "hermes-cli", message: `hermes gateway restart failed: ${message}` };
  }
}

function upsertHermesConfiguredProvider(target: Map<string, HermesConfiguredProvider>, provider: HermesConfiguredProvider): void {
  const existing = target.get(provider.name);
  if (!existing) {
    target.set(provider.name, {
      ...provider,
      sources: [...new Set(provider.sources)],
      models: [...new Set(provider.models.filter(Boolean))]
    });
    return;
  }

  target.set(provider.name, {
    name: provider.name,
    sources: [...new Set([...existing.sources, ...provider.sources])],
    baseUrl: provider.baseUrl || existing.baseUrl,
    defaultModel: provider.defaultModel || existing.defaultModel,
    apiMode: provider.apiMode || existing.apiMode,
    models: [...new Set([...existing.models, ...provider.models].filter(Boolean))],
    apiKeyConfigured: existing.apiKeyConfigured || provider.apiKeyConfigured,
    active: existing.active || provider.active
  });
}
