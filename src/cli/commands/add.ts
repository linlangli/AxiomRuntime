import { addProvider } from "../../core/providers/provider-service.js";
import { getCachedModels, getProviderPriorityOptions, listProviders, updateProvider } from "../../core/providers/provider-service.js";
import { writeLog } from "../../core/logs/log-service.js";
import { describeProviderRequestProfile } from "../../core/providers/provider-request-profile.js";
import { promptSelect, promptText } from "../prompts/prompt.js";

type AddCommandPrompts = {
  text?: typeof promptText;
  select?: typeof promptSelect;
};

export async function runAddCommand(args: string[], prompts: AddCommandPrompts = {}): Promise<void> {
  const askText = prompts.text ?? promptText;
  const askSelect = prompts.select ?? promptSelect;
  const [nameArg, baseUrlArg, apiKeyArg, modelArg] = args;
  const interactive = !nameArg || !baseUrlArg || !apiKeyArg;
  const name = nameArg ?? await askText("Provider name");
  const baseUrl = baseUrlArg ?? await askText("Base URL");
  const apiKey = apiKeyArg ?? await askText("API key");
  let verifiedModel = modelArg?.trim() || "";
  const existingProviders = interactive ? await listProviders() : [];
  const level = interactive
    ? await askSelect(
        "Select priority level (0 excludes automatic fallback)",
        getProviderPriorityOptions(existingProviders).map(({ level: value, occupiedBy }) => ({
          label: value === 0
            ? "excluded from automatic fallback"
            : occupiedBy ? `replace ${occupiedBy}` : "lowest automatic priority",
          value,
          key: String(value)
        }))
      )
    : undefined;

  let provider;
  try {
    provider = await addProvider({ name, baseUrl, apiKey, model: verifiedModel || undefined, level });
  } catch (error) {
    const isProbeFailure = error instanceof Error
      && error.message.startsWith("Provider configuration probe failed:");
    if (!interactive || verifiedModel || !isProbeFailure) throw error;
    console.log(error instanceof Error ? error.message : String(error));
    console.log("Automatic model discovery failed. Enter a known model for direct verification.");
    verifiedModel = await askText("Model name");
    if (!verifiedModel) throw error;
    provider = await addProvider({ name, baseUrl, apiKey, model: verifiedModel, level });
  }
  if (interactive && !verifiedModel) {
    const models = await getCachedModels(provider.name);
    if (models.length) {
      const model = await askSelect(
        "Select default model",
        models.map((item) => ({ label: item, value: item }))
      );
      provider = await updateProvider(provider.name, { model });
    }
  }

  console.log(`Added provider: ${provider.name}`);
  console.log(`Level: ${provider.level}`);
  console.log(`Mode: ${provider.mode}`);
  console.log(`Default model: ${provider.model || "(not detected)"}`);
  console.log(`Detected request profile: ${describeProviderRequestProfile(provider)}`);
  console.log(`Models: ${(await getCachedModels(provider.name)).join(", ")}`);
  await writeLog({
    category: "provider",
    action: "provider_add",
    message: `Added provider: ${provider.name}`,
    metadata: { provider: provider.name, baseUrl: provider.baseUrl, level: provider.level, model: provider.model || null }
  });
}
