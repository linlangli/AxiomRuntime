import { getProviderStatuses } from "../../core/status/status-service.js";
import { writeLog } from "../../core/logs/log-service.js";
import type { ProviderStatus, ToolProviderStatus } from "../../core/types.js";
import { maskSecret } from "../output/table.js";
import { describeProviderRequestProfile } from "../../core/providers/provider-request-profile.js";

export async function runStatusCommand(): Promise<void> {
  const statuses = await getProviderStatuses({ refresh: true });
  await writeLog({
    category: "usage",
    action: "status_refresh",
    message: `Refreshed ${statuses.length} provider(s) for status.`,
    metadata: { providers: statuses.map((status) => ({ name: status.name, health: status.health, models: status.models.length })) }
  });
  printStatusCards(statuses);
}

function printStatusCards(statuses: ProviderStatus[]): void {
  if (!statuses.length) {
    console.log("No providers configured. Run `ai add` first.");
    return;
  }

  console.log(`AI Gateway Status (${statuses.length})`);
  console.log("=".repeat(72));

  statuses.forEach((status, index) => {
    const isDefault = status.level === 1;
    const title = `${status.level.toString().padStart(2, "0")}  ${status.name}${isDefault ? "  [default]" : ""}`;
    const healthLine = `${title}  health:${status.health}  mode:${status.mode}`;

    console.log(healthLine);
    console.log("-".repeat(Math.min(72, Math.max(28, healthLine.length))));
    printToolStatus("Claude", status.claude);
    printToolStatus("Codex ", status.codex);
    console.log(`  Config   ${status.baseUrl}`);
    console.log(`  API Key  ${maskSecret(status.apiKey)}`);
    console.log(`  Models   ${status.models.length}`);
    console.log(`  Probe    ${describeProviderRequestProfile(status)}`);
    console.log(`  Usage    ${status.weeklyTokens} weekly token(s), ${status.usageShare}% share`);
    console.log(`  Checked  ${status.lastCheckedAt ?? "(never)"}`);
    if (status.lastError) {
      console.log(`  Error    ${status.lastError}`);
    }

    if (index < statuses.length - 1) {
      console.log("");
    }
  });
}

function printToolStatus(label: string, status: ToolProviderStatus): void {
  const state = status.state;
  const model = status.model ?? "(none)";
  const timing = status.checkedAt ? `  ${status.durationMs}ms / ${status.attempts} attempt(s)` : "";
  console.log(`  ${label}  ${state}  ${model}${timing}`);
  console.log(`          ${status.baseUrl}`);
  console.log(`          ${status.note}`);
}
