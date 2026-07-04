import { listProviders } from "../../core/providers/provider-service.js";
import { maskSecret, printTable } from "../output/table.js";

export async function runListCommand(): Promise<void> {
  const providers = await listProviders();
  printTable(
    providers.map((provider) => ({
      level: provider.level,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: maskSecret(provider.apiKey),
      mode: provider.mode,
      model: provider.model || "(none)"
    }))
  );
}
