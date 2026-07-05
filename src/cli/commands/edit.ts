import { readCache } from "../../core/config/cache-store.js";
import { writeLog } from "../../core/logs/log-service.js";
import { listProviders, updateProvider } from "../../core/providers/provider-service.js";
import type { Provider, ProviderMode } from "../../core/types.js";
import { autoSyncHermesProviders } from "./hermes-sync.js";
import { promptSelect, promptText } from "../prompts/prompt.js";

type EditableField = "name" | "baseUrl" | "apiKey" | "mode" | "level" | "model";

export async function runEditCommand(): Promise<void> {
  const providers = await listProviders();
  if (!providers.length) {
    console.log("No providers configured. Run `ai add` first.");
    return;
  }

  const providerName = await promptSelect(
    "Select provider",
    providers.map((provider) => ({ label: `${provider.name} (level ${provider.level})`, value: provider.name }))
  );
  const provider = providers.find((item) => item.name === providerName)!;

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
  console.log(`Updated provider: ${updated.name}`);
  await autoSyncHermesProviders();
  await writeLog({
    category: "provider",
    action: "provider_edit",
    message: `Updated provider: ${updated.name}`,
    metadata: { provider: provider.name, field, renamedTo: updated.name !== provider.name ? updated.name : undefined }
  });
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
