import { writeLog } from "../../core/logs/log-service.js";
import { readCache } from "../../core/config/cache-store.js";
import {
  listAvailableCodexGptModels,
  resolveCodexProviderModel,
  setCodexProvider,
  setCodexProxy
} from "../../core/integrations/codex-provider-config.js";
import { listProviders } from "../../core/providers/provider-service.js";
import type { CacheFile, Provider } from "../../core/types.js";
import { promptSelect, promptText } from "../prompts/prompt.js";

type CodexSetMode = "chatgpt" | "provider" | "proxy";

const SET_CODEX_USAGE = "Usage: ai set codex [chatgpt | provider [name] [model-id] | proxy <host:port|url|off>]";

export async function runSetCommand(args: string[]): Promise<void> {
  const [targetArg, modeArg, providerNameArg, modelArg, ...extra] = args;
  const target = targetArg ?? "codex";
  if (target !== "codex") {
    throw new Error(SET_CODEX_USAGE);
  }
  if (extra.length) {
    throw new Error(SET_CODEX_USAGE);
  }

  const mode = await getMode(modeArg);
  if (mode === "proxy") {
    if (modelArg) throw new Error(SET_CODEX_USAGE);
    const proxyValue = providerNameArg ?? await promptText("Codex proxy (host:port, URL, or off)");
    const result = await setCodexProxy(proxyValue);
    console.log(result.proxyUrl ? `Codex proxy set to: ${result.proxyUrl}` : "Codex proxy cleared.");
    console.log(`Updated: ${result.configPath}`);
    if (!result.environment.applied && result.environment.reason) {
      console.log(result.environment.reason);
    }
    printRestartResult(result.restart);
    await writeLog({
      category: "provider",
      action: "codex_proxy_set",
      message: result.proxyUrl ? "Codex proxy enabled." : "Codex proxy cleared.",
      metadata: {
        enabled: Boolean(result.proxyUrl),
        desktopEnvironmentApplied: result.environment.applied,
        restartScheduled: result.restart.scheduled
      }
    });
    return;
  }
  if (mode === "chatgpt" && (providerNameArg || modelArg)) {
    throw new Error("Usage: ai set codex chatgpt");
  }
  const selection = mode === "chatgpt"
    ? { type: "chatgpt" as const }
    : { type: "provider" as const, ...await getProviderAndModel(providerNameArg, modelArg) };

  if (mode === "chatgpt") {
    console.log("Opening ChatGPT login in your browser...");
  }
  const result = await setCodexProvider(selection);
  console.log(`Codex provider set to: ${result.providerName}`);
  if (result.model) console.log(`Codex model set to: ${result.model}`);
  console.log(`Updated: ${result.configPath}`);
  console.log(`Updated: ${result.authPath}`);
  printRestartResult(result.restart);

  await writeLog({
    category: "provider",
    action: "codex_provider_set",
    message: `Codex provider set to ${result.providerName}.`,
    metadata: {
      selection: result.selection,
      provider: result.providerName,
      providerId: result.providerId,
      model: result.model,
      restartScheduled: result.restart.scheduled
    }
  });
}

async function getMode(value?: string): Promise<CodexSetMode> {
  if (value === "chatgpt" || value === "provider" || value === "proxy") return value;
  if (value) {
    throw new Error(`Unknown Codex setting: ${value}`);
  }
  return promptSelect<CodexSetMode>("Set Codex", [
    { label: "ChatGPT account", value: "chatgpt" },
    { label: "Configured provider", value: "provider" },
    { label: "Proxy", value: "proxy" }
  ]);
}

function printRestartResult(restart: { scheduled: boolean; appPath?: string; reason?: string }): void {
  if (restart.scheduled) {
    console.log(`Restarting ${restart.appPath ?? "Codex app"}...`);
  } else {
    console.log(`Restart Codex app manually. ${restart.reason ?? ""}`.trim());
  }
}

async function getProviderAndModel(name?: string, requestedModel?: string): Promise<{
  provider: Provider;
  model: string;
}> {
  const [providers, cache] = await Promise.all([listProviders(), readCache()]);
  return selectCodexProviderAndModel(providers, cache.providers, name, requestedModel);
}

export async function selectCodexProviderAndModel(
  providers: Provider[],
  providerCache: CacheFile["providers"],
  name?: string,
  requestedModel?: string,
  select: typeof promptSelect = promptSelect
): Promise<{ provider: Provider; model: string }> {
  if (!providers.length) {
    throw new Error("No providers configured. Run `ai provider add` first.");
  }
  if (!name && !providers.some((provider) => providerGptModels(provider.name, providerCache).length)) {
    throw new Error("No configured provider has available GPT models. Run `ai status` to refresh model lists.");
  }
  const providerName = name ?? await select(
    "Select provider for Codex",
    providers.map((provider) => ({
      label: `${provider.name} / ${providerGptModels(provider.name, providerCache).length} GPT models`,
      value: provider.name
    }))
  );
  const provider = providers.find((item) => item.name === providerName);
  if (!provider) {
    throw new Error(`Provider not found: ${providerName}`);
  }
  const availableModels = providerGptModels(provider.name, providerCache);
  if (!availableModels.length) {
    resolveCodexProviderModel(provider.name, availableModels);
  }
  const model = requestedModel
    ? resolveCodexProviderModel(provider.name, availableModels, requestedModel)
    : name
      ? resolveCodexProviderModel(provider.name, availableModels)
      : await select(
        `Select GPT model for ${provider.name}`,
        availableModels.map((availableModel) => ({ label: availableModel, value: availableModel }))
      );
  return { provider, model };
}

function providerGptModels(
  providerName: string,
  providerCache: Record<string, { models: string[] } | undefined>
): string[] {
  return listAvailableCodexGptModels(providerCache[providerName]?.models ?? []);
}
