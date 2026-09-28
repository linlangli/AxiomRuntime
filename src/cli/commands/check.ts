import { writeLog } from "../../core/logs/log-service.js";
import { listProviders } from "../../core/providers/provider-service.js";
import { getProviderStatus } from "../../core/status/status-service.js";
import { promptSelect } from "../prompts/prompt.js";
import { printProviderStatuses } from "./status.js";

type ProviderSelector = (
  message: string,
  choices: Array<{ label: string; value: string }>
) => Promise<string>;

export async function runCheckCommand(
  args: string[],
  options: { selectProvider?: ProviderSelector } = {}
): Promise<void> {
  const providers = await listProviders();
  if (!providers.length) {
    throw new Error("No providers configured. Run `ai add` first.");
  }

  const requestedName = args.join(" ").trim();
  const providerName = requestedName || await (options.selectProvider ?? promptSelect)(
    "Select provider to check",
    providers.map((provider) => ({
      label: `${provider.name} (${provider.model || "no default model"})`,
      value: provider.name
    }))
  );
  const status = await getProviderStatus(providerName, { refresh: true });

  await writeLog({
    category: "provider",
    action: "provider_check",
    message: `Checked provider: ${status.name}`,
    metadata: {
      provider: status.name,
      health: status.health,
      claude: status.claude.state,
      codex: status.codex.state,
      models: status.models.length
    }
  });
  printProviderStatuses([status], `AI Gateway Provider Check: ${status.name}`);
}
