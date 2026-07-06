import { readCache } from "../../core/config/cache-store.js";
import {
  listHermesRobots,
  switchHermesRobotsProvider,
  syncHermesRobotToLocalConfigAndRestart,
  updateHermesRobot
} from "../../core/hermes/hermes-service.js";
import { writeLog } from "../../core/logs/log-service.js";
import { deleteProvider, listProviders, updateProvider } from "../../core/providers/provider-service.js";
import type { Provider, ProviderMode } from "../../core/types.js";
import { autoSyncHermesProviders } from "./hermes-sync.js";
import { promptConfirm, promptSelect, promptText } from "../prompts/prompt.js";

type EditableField = "name" | "baseUrl" | "apiKey" | "mode" | "level" | "model";

export async function runProviderEditCommand(name?: string): Promise<void> {
  const providers = await listProviders();
  if (!providers.length) {
    console.log("No providers configured. Run `ai add` first.");
    return;
  }

  const providerName = name ?? await selectProviderName(providers);
  const provider = providers.find((item) => item.name === providerName)!;
  if (!provider) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  const field = await promptSelect<EditableField>("Select field", [
    { label: "name", value: "name" },
    { label: "baseUrl", value: "baseUrl" },
    { label: "apiKey", value: "apiKey" },
    { label: "mode", value: "mode" },
    { label: "level", value: "level" },
    { label: "model", value: "model" }
  ]);

  const patch = await buildPatch(provider, providers, field);
  const updated = await updateProvider(provider.name, patch);
  if (updated.name !== provider.name) {
    await updateHermesRobotProviderReferences(provider.name, updated.name);
  }
  console.log(`Updated provider: ${updated.name}`);
  await autoSyncHermesProviders();
  await writeLog({
    category: "provider",
    action: "provider_edit",
    message: `Updated provider: ${updated.name}`,
    metadata: { provider: provider.name, field, renamedTo: updated.name !== provider.name ? updated.name : undefined }
  });
}

export async function runProviderDeleteCommand(name?: string): Promise<void> {
  const providers = await listProviders();
  if (!providers.length) {
    console.log("No providers configured. Run `ai add` first.");
    return;
  }

  const providerName = name ?? await selectProviderName(providers);
  const provider = providers.find((item) => item.name === providerName);
  if (!provider) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  const robots = await listHermesRobots();
  const usedBy = robots.filter((robot) => robot.provider === provider.name).map((robot) => robot.name);
  const fallbackProvider = getFallbackProvider(providers, provider.name);
  if (usedBy.length && !fallbackProvider) {
    throw new Error(`Cannot delete provider ${provider.name}: Hermes robot(s) use it and no fallback provider exists.`);
  }
  const suffix = usedBy.length ? ` Used by Hermes robot(s): ${usedBy.join(", ")}.` : "";
  const confirmed = await promptConfirm(`Delete provider ${provider.name}?${suffix}`, false);
  if (!confirmed) {
    console.log("Delete cancelled.");
    return;
  }

  await deleteProvider(provider.name);
  if (usedBy.length && fallbackProvider) {
    const count = await switchHermesRobotsProvider(provider.name, fallbackProvider);
    console.log(`Updated ${count} Hermes robot provider reference(s): ${provider.name} -> ${fallbackProvider.name}`);
    const result = await syncHermesRobotToLocalConfigAndRestart(usedBy[0]!);
    console.log(`Synced local Hermes config: ${result.configPath}`);
    console.log(`Active Hermes default: ${result.robot.name} / ${result.provider.name} / ${result.robot.model}`);
    console.log(result.restart.message);
  } else {
    await autoSyncHermesProviders();
  }
  console.log(`Deleted provider: ${provider.name}`);
  await writeLog({
    category: "provider",
    action: "provider_delete",
    message: `Deleted provider: ${provider.name}`,
    metadata: { provider: provider.name, hermesRobots: usedBy }
  });
}

function getFallbackProvider(providers: Provider[], deletedProviderName: string): Provider | null {
  return providers
    .filter((provider) => provider.name !== deletedProviderName)
    .sort((a, b) => a.level - b.level)[0] ?? null;
}

async function selectProviderName(providers: Provider[]): Promise<string> {
  return promptSelect(
    "Select provider",
    providers.map((provider) => ({ label: `${provider.name} (level ${provider.level})`, value: provider.name }))
  );
}

async function buildPatch(provider: Provider, providers: Provider[], field: EditableField): Promise<Partial<Provider>> {
  if (field === "mode") {
    const mode = await promptSelect<ProviderMode>("Select mode", [
      { label: "auto", value: "auto" },
      { label: "ask", value: "ask" }
    ]);
    return { mode };
  }

  if (field === "level") {
    const level = await promptSelect<number>(
      "Select level",
      providers.map((item) => ({ label: `${item.level}${item.name === provider.name ? " (current)" : ` (${item.name})`}`, value: item.level }))
    );
    return { level };
  }

  if (field === "model") {
    const cache = await readCache();
    const models = cache.providers[provider.name]?.models ?? [];
    if (!models.length) {
      throw new Error("No cached models found. Run `ai status` first.");
    }
    const model = await promptSelect(
      "Select model",
      models.map((model) => ({ label: model, value: model }))
    );
    return { model };
  }

  const value = await promptText(`New ${field}`, { defaultValue: provider[field] });
  return { [field]: value };
}

async function updateHermesRobotProviderReferences(from: string, to: string): Promise<void> {
  const robots = await listHermesRobots();
  const affected = robots.filter((robot) => robot.provider === from);
  for (const robot of affected) {
    await updateHermesRobot(robot.name, { provider: to });
  }
  if (affected.length) {
    console.log(`Updated ${affected.length} Hermes robot provider reference(s): ${from} -> ${to}`);
  }
}
