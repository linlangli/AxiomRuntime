import { migrateProviderSecrets, providerSecretStatus } from "../../core/config/provider-secret-service.js";

export async function runSecretsCommand(args: string[]): Promise<void> {
  const [action = "status", ...options] = args;
  if (!["status", "migrate", "rollback"].includes(action) || options.some(option => option !== "--yes")) throw new Error("Usage: ai secrets [status|migrate|rollback --yes]");
  if (action === "rollback" && !options.includes("--yes")) throw new Error("Rollback writes plaintext Provider keys and snapshots. Use `ai secrets rollback --yes` to explicitly authorize it.");
  const status = action === "status" ? await providerSecretStatus() : await migrateProviderSecrets(action === "rollback");
  console.log(JSON.stringify(status, null, 2));
}
