import { getProviderStatuses } from "../../core/status/status-service.js";
import { writeLog } from "../../core/logs/log-service.js";
import { maskSecret, printTable } from "../output/table.js";

export async function runStatusCommand(): Promise<void> {
  const statuses = await getProviderStatuses({ refresh: true });
  await writeLog({
    category: "usage",
    action: "status_refresh",
    message: `Refreshed ${statuses.length} provider(s) for status.`,
    metadata: { providers: statuses.map((status) => ({ name: status.name, health: status.health, models: status.models.length })) }
  });
  printTable(
    statuses.map((status) => ({
      level: status.level,
      name: status.name,
      health: status.health,
      mode: status.mode,
      model: status.model || "(none)",
      baseUrl: status.baseUrl,
      apiKey: maskSecret(status.apiKey),
      models: status.models.length,
      weeklyTokens: status.weeklyTokens,
      usageShare: `${status.usageShare}%`,
      checked: status.lastCheckedAt ?? "(never)"
    }))
  );
}
