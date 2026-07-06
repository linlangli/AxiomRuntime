import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getHermesExportPath } from "../config/paths.js";
import { readCache, upsertProviderCache } from "../config/cache-store.js";
import { readProviders, writeProviders } from "../config/providers-store.js";
import { writeJsonFile } from "../config/json-store.js";
import { writeLog } from "../logs/log-service.js";
import { refreshAllProviders } from "../providers/provider-service.js";
import { getSecretFingerprint, getToolBaseUrl } from "../runner/tool-runner.js";
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
import type {
  AddHermesRobotInput,
  HermesConfiguredProvider,
  HermesConfiguredProvidersResult,
  HermesRobot,
  HermesRobotStatus,
  ImportLocalHermesResult,
  ImportHermesRobotResult,
  UpdateHermesRobotInput
} from "./hermes-types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HERMES_LAUNCHD_LABEL = "ai.hermes.gateway";

type LocalHermesProviderRecord = {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  apiMode: string;
  models: string[];
  active: boolean;
};

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
  const nextConfig = await buildLocalHermesConfig(configPath, robot, provider, providers, providerModels);
  const nextEnv = await buildLocalHermesEnv(envPath);
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
  const nextEnv = await buildLocalHermesEnv(envPath);
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
  return { configPath, envPath, metadata };
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
  const [existingProviders, existingRobots, localRobot, localProviders] = await Promise.all([
    readProviders(),
    listHermesRobots(),
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

async function buildLocalHermesConfig(
  configPath: string,
  robot: HermesRobot,
  provider: Provider,
  providers: Provider[],
  providerModels: Record<string, string[]>
): Promise<string> {
  const existing = await readTextIfExists(configPath);
  const modelBlock = [
    "model:",
    `  default: ${yamlString(robot.model)}`,
    `  provider: ${yamlString(provider.name)}`,
    `  base_url: ${yamlString(getHermesProviderBaseUrl(robot, provider))}`,
    `  api_key: ${yamlString(provider.apiKey)}`
  ];
  const withModel = replaceTopLevelYamlBlock(existing, "model", modelBlock);
  const withProviders = replaceTopLevelYamlBlock(withModel, "providers", buildHermesProvidersBlock(providers, providerModels));
  return replaceTopLevelYamlBlock(withProviders, "custom_providers", buildHermesCustomProvidersBlock(providers, providerModels));
}

async function buildLocalHermesEnv(envPath: string): Promise<string> {
  const existing = await readTextIfExists(envPath);
  const updates: Record<string, string> = {
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "",
    ANTHROPIC_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    OPENROUTER_API_KEY: "",
    OPENROUTER_BASE_URL: "",
    COPILOT_GITHUB_TOKEN: "",
    GH_TOKEN: ""
  };
  return replaceEnvValues(existing, updates);
}

function buildHermesProvidersBlock(providers: Provider[], providerModels: Record<string, string[]>): string[] {
  const lines = ["providers:"];
  if (!providers.length) return [...lines, "  {}"];
  for (const provider of providers) {
    const models = providerModels[provider.name] ?? [];
    lines.push(`  ${yamlKey(provider.name)}:`);
    lines.push(`    name: ${yamlString(provider.name)}`);
    lines.push(`    api: ${yamlString(getProviderDefaultBaseUrl(provider))}`);
    lines.push(`    api_key: ${yamlString(provider.apiKey)}`);
    lines.push(`    default_model: ${yamlString(provider.model)}`);
    lines.push(`    transport: ${yamlString(getProviderApiMode(provider))}`);
    lines.push("    ai_gateway_managed: true");
    if (models.length) {
      lines.push("    models:");
      for (const model of models) lines.push(`      - ${yamlString(model)}`);
    } else {
      lines.push("    models: []");
    }
  }
  return lines;
}

function buildHermesCustomProvidersBlock(providers: Provider[], providerModels: Record<string, string[]>): string[] {
  const lines = ["custom_providers:"];
  if (!providers.length) return [...lines, "  []"];
  for (const provider of providers) {
    const models = providerModels[provider.name] ?? [];
    lines.push(`  - name: ${yamlString(provider.name)}`);
    lines.push(`    base_url: ${yamlString(getProviderDefaultBaseUrl(provider))}`);
    lines.push(`    api_key: ${yamlString(provider.apiKey)}`);
    lines.push(`    model: ${yamlString(provider.model)}`);
    lines.push(`    api_mode: ${yamlString(getProviderApiMode(provider))}`);
    lines.push("    ai_gateway_managed: true");
    if (models.length) {
      lines.push("    models:");
      for (const model of models) {
        lines.push(`      ${yamlKey(model)}:`);
        lines.push("        context_length: null");
      }
    } else {
      lines.push("    models: {}");
    }
  }
  return lines;
}

function reconcileLocalHermesModelBlock(raw: string, providers: Provider[]): string {
  const modelBlock = extractYamlBlock(raw, "model");
  const activeProviderName = extractYamlValue(modelBlock, "provider");
  if (!activeProviderName) return raw;

  const provider = providers.find((item) => item.name === activeProviderName);
  if (!provider) {
    return replaceTopLevelYamlBlock(raw, "model", [
      "model:",
      "  default: \"\"",
      "  provider: \"\"",
      "  base_url: \"\"",
      "  api_key: \"\""
    ]);
  }

  const model = extractYamlValue(modelBlock, "default") || provider.model;
  return replaceTopLevelYamlBlock(raw, "model", [
    "model:",
    `  default: ${yamlString(model)}`,
    `  provider: ${yamlString(provider.name)}`,
    `  base_url: ${yamlString(getHermesProviderBaseUrl({ model } as HermesRobot, provider))}`,
    `  api_key: ${yamlString(provider.apiKey)}`
  ]);
}

async function pruneNativeHermesAuthStore(authPath: string): Promise<void> {
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

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function replaceTopLevelYamlBlock(raw: string, key: string, replacement: string[]): string {
  const lines = raw ? raw.split(/\r?\n/) : [];
  const start = lines.findIndex((line) => line.trim() === `${key}:` && !line.startsWith(" "));
  if (start < 0) {
    const prefix = raw.trim() ? `${raw.replace(/\s*$/, "")}\n\n` : "";
    return `${prefix}${replacement.join("\n")}\n`;
  }

  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!))) {
    end += 1;
  }
  const nextLines = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
  return `${nextLines.join("\n").replace(/\s*$/, "")}\n`;
}

function replaceEnvValues(raw: string, updates: Record<string, string>): string {
  const lines = raw ? raw.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;
    const key = match[1]!;
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${quoteEnvValue(updates[key]!)}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }
  return `${nextLines.filter((line, index, array) => line || index < array.length - 1).join("\n").replace(/\s*$/, "")}\n`;
}

function quoteEnvValue(value: string): string {
  if (!value) return "";
  return JSON.stringify(value);
}

function getHermesProviderBaseUrl(robot: HermesRobot, provider: Provider): string {
  return getToolBaseUrl(robot.model.toLowerCase().includes("claude") ? "claude" : "codex", provider);
}

function getProviderDefaultBaseUrl(provider: Provider): string {
  return getToolBaseUrl(provider.model.toLowerCase().includes("claude") ? "claude" : "codex", provider);
}

function getProviderApiMode(provider: Provider): string {
  return provider.model.toLowerCase().includes("claude") ? "anthropic_messages" : "chat_completions";
}

function yamlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : yamlString(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
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

async function discoverLocalHermesProviders(sourceDir: string): Promise<LocalHermesProviderRecord[]> {
  const raw = await readTextIfExists(path.join(sourceDir, "config.yaml"));
  return parseLocalHermesProviderRecords(raw).providers;
}

async function importLocalHermesProviders(
  existingProviders: Provider[],
  localProviders: LocalHermesProviderRecord[],
  options: { overwrite?: boolean }
): Promise<{ providers: Provider[]; importedProviders: Provider[]; skippedProviders: Provider[] }> {
  const importedProviders: Provider[] = [];
  const skippedProviders: Provider[] = [];
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
    } else {
      nextProviders.push(provider);
    }
    importedProviders.push(provider);
  }

  if (importedProviders.length) {
    await writeProviders(nextProviders);
    nextProviders = await readProviders();
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

function parseLocalHermesProviderRecords(raw: string): { activeProvider: string; providers: LocalHermesProviderRecord[] } {
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

function extractYamlModels(block: string): string[] {
  const models = new Set<string>();
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s+models:\s*/.test(line));
  if (start < 0) return [];
  const modelIndent = lines[start]!.match(/^(\s*)/)?.[1].length ?? 0;

  for (const line of lines.slice(start + 1)) {
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (line.trim() && indent <= modelIndent) break;
    const listItem = line.match(/^\s+-\s*(.+?)\s*$/);
    if (listItem) {
      models.add(stripYamlQuotes(listItem[1]!));
      continue;
    }
    const mapKey = line.match(/^\s+(.+?):\s*$/);
    if (mapKey) {
      const value = stripYamlQuotes(mapKey[1]!);
      if (value && value !== "{}") models.add(value);
    }
  }

  return [...models];
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
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
