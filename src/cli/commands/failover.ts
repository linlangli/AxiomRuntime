import { getRuntimeConfigPath } from "../../core/config/paths.js";
import { loadRuntimeConfig, setRuntimeFailover } from "../../core/config/runtime-config.js";
import { writeLog } from "../../core/logs/log-service.js";

const FAILOVER_USAGE = "Usage: ai failover on | ai failover off";

export async function runFailoverCommand(args: string[]): Promise<void> {
  const [value, ...extra] = args;
  if (extra.length) throw new Error(FAILOVER_USAGE);

  if (value === undefined) {
    const config = await loadRuntimeConfig();
    const disabled = config.failoverDisabled === true;
    console.log(disabled
      ? "Provider auto-failover is OFF. A failing provider will not switch to the next candidate."
      : "Provider auto-failover is ON. A failing provider will switch to the next candidate by level.");
    return;
  }

  if (value !== "on" && value !== "off") {
    throw new Error(FAILOVER_USAGE);
  }

  const disable = value === "off";
  const config = await setRuntimeFailover(disable);

  console.log(disable
    ? "Provider auto-failover disabled. A failing provider will not switch to the next candidate."
    : "Provider auto-failover enabled. A failing provider will switch to the next candidate by level.");
  console.log(`Updated: ${getRuntimeConfigPath()}`);

  await writeLog({
    category: "provider",
    action: "runtime_failover_set",
    message: disable ? "Provider auto-failover disabled." : "Provider auto-failover enabled.",
    metadata: { enabled: !disable, failoverDisabled: config.failoverDisabled === true }
  });
}
