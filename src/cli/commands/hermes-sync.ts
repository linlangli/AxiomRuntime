import { syncHermesProvidersToLocalConfigAndRestart } from "../../core/hermes/hermes-service.js";
import { writeLog } from "../../core/logs/log-service.js";

export async function autoSyncHermesProviders(): Promise<void> {
  try {
    const result = await syncHermesProvidersToLocalConfigAndRestart();
    console.log(`Synced Hermes providers: ${result.configPath}`);
    console.log(result.restart.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeLog({
      level: "warn",
      category: "system",
      action: "hermes_provider_auto_sync_skipped",
      message: `Hermes provider auto-sync skipped: ${message}`
    });
    console.log(`Hermes provider sync skipped: ${message}`);
  }
}
