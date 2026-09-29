import { readCache } from "../../core/config/cache-store.js";
import { writeLog } from "../../core/logs/log-service.js";
import { deleteProvider, getProviderPriorityOptions, listProviders, updateProvider } from "../../core/providers/provider-service.js";
import type { Provider, ProviderMode } from "../../core/types.js";
import { promptProxyUrl } from "../prompts/proxy.js";
import { promptConfirm, promptSelect, promptText } from "../prompts/prompt.js";

type EditableField = "name" | "baseUrl" | "apiKey" | "mode" | "level" | "model" | "proxyUrl";

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
    { label: "model", value: "model" },
    { label: "proxyUrl", value: "proxyUrl" }
  ]);

  const patch = await buildPatch(provider, providers, field);
  if (!patch) {
    console.log("Edit cancelled.");
    return;
  }
  const updated = await updateProvider(provider.name, patch);
  console.log(`Updated provider: ${updated.name}`);
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

  const confirmed = await promptConfirm(`Delete provider ${provider.name}?`, false);
  if (!confirmed) {
    console.log("Delete cancelled.");
    return;
  }

  await deleteProvider(provider.name);
  console.log(`Deleted provider: ${provider.name}`);
  await writeLog({
    category: "provider",
    action: "provider_delete",
    message: `Deleted provider: ${provider.name}`,
    metadata: { provider: provider.name }
  });
}

async function selectProviderName(providers: Provider[]): Promise<string> {
  return promptSelect(
    "Select provider",
    providers.map((provider) => ({ label: `${provider.name} (level ${provider.level})`, value: provider.name }))
  );
}

async function buildPatch(
  provider: Provider,
  providers: Provider[],
  field: EditableField
): Promise<Partial<Provider> | null> {
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
      buildProviderLevelChoices(providers, provider.name)
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

  if (field === "proxyUrl") {
    // 复用代理提示的 Edit/Disable/Cancel 流；空串是显式清除哨兵，normalizeProviders 会剥离。
    const proxyUrl = await promptProxyUrl({ currentUrl: provider.proxyUrl });
    if (proxyUrl === undefined) return null;
    return proxyUrl ? { proxyUrl } : { proxyUrl: "" };
  }

  const value = await promptText(`New ${field}`, { defaultValue: provider[field] });
  return { [field]: value };
}

export function buildProviderLevelChoices(
  providers: Provider[],
  providerName: string
): Array<{ label: string; value: number; key: string }> {
  return getProviderPriorityOptions(providers, providerName).map(({ level, occupiedBy }) => ({
    // label 不再重复 level 数字：行首的输入标识就是 level 本身。
    label: level === 0
      ? "excluded from automatic fallback"
      : occupiedBy === providerName
        ? `current: ${providerName}`
        : occupiedBy
          ? `swap with ${occupiedBy}`
          : "lowest automatic priority",
    value: level,
    key: String(level)
  }));
}
