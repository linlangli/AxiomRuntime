import { getProviderStatuses } from "../../core/status/status-service.js";
import { maskSecret, printTable } from "../output/table.js";

export async function runStatusCommand(): Promise<void> {
  const statuses = await getProviderStatuses({ refresh: true });
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
