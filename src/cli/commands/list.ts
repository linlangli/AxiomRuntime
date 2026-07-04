import { listProviders } from "../../core/providers/provider-service.js";
import { maskSecret } from "../output/table.js";

export async function runListCommand(): Promise<void> {
  const providers = await listProviders();
  if (!providers.length) {
    console.log("No providers configured. Run `ai add` first.");
    return;
  }

  console.log(`AI Gateway Providers (${providers.length})`);
  console.log("=".repeat(72));

  providers.forEach((provider, index) => {
    const isDefault = provider.level === 1;
    const title = `${provider.name}${isDefault ? "  [default]" : ""}`;
    const header = `${provider.level.toString().padStart(2, "0")}  ${title}`;

    console.log(header);
    console.log("-".repeat(Math.min(72, Math.max(24, header.length))));
    console.log(`  Base URL  ${provider.baseUrl}`);
    console.log(`  API Key   ${maskSecret(provider.apiKey)}`);
    console.log(`  Mode      ${provider.mode}`);
    console.log(`  Model     ${provider.model || "(none)"}`);

    if (index < providers.length - 1) {
      console.log("");
    }
  });
}
