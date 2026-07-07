import { addProvider } from "../../core/providers/provider-service.js";
import { getCachedModels, updateProvider } from "../../core/providers/provider-service.js";
import { writeLog } from "../../core/logs/log-service.js";
import { promptSelect, promptText } from "../prompts/prompt.js";

export async function runAddCommand(args: string[]): Promise<void> {
  const [nameArg, baseUrlArg, apiKeyArg] = args;
  const interactive = !nameArg || !baseUrlArg || !apiKeyArg;
  const name = nameArg ?? await promptText("Provider name");
  const baseUrl = baseUrlArg ?? await promptText("Base URL");
  const apiKey = apiKeyArg ?? await promptText("API key");

  let provider = await addProvider({ name, baseUrl, apiKey });
  if (interactive) {
    const models = await getCachedModels(provider.name);
    if (models.length) {
      const model = await promptSelect(
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
  await writeLog({
    category: "provider",
    action: "provider_add",
    message: `Added provider: ${provider.name}`,
    metadata: { provider: provider.name, baseUrl: provider.baseUrl, level: provider.level, model: provider.model || null }
  });
}
