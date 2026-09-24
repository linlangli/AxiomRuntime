import { discoverProviderModels, listProviders } from "../../core/providers/provider-service.js";
import { promptSelect } from "../prompts/prompt.js";

type ProviderSelector = (
  message: string,
  choices: Array<{ label: string; value: string }>
) => Promise<string>;

export async function runModelsCommand(
  args: string[],
  options: { selectProvider?: ProviderSelector } = {}
): Promise<void> {
  const providers = await listProviders();
  if (!providers.length) {
    throw new Error("No providers configured. Run `ai add` first.");
  }

  const requestedName = args.join(" ").trim();
  const providerName = requestedName || await (options.selectProvider ?? promptSelect)(
    "Select provider",
    providers.map((provider) => ({
      label: provider.name,
      value: provider.name
    }))
  );
  const result = await discoverProviderModels(providerName);

  console.log(`Models for ${result.provider.name} (${result.models.length})`);
  console.log("=".repeat(72));
  result.models.forEach((model, index) => {
    console.log(`${String(index + 1).padStart(3, " ")}. ${model}`);
  });
  console.log(`Checked: ${result.checkedAt}`);
}
