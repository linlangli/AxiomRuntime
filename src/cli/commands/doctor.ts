import { runDeepDoctor, runDoctor, type DoctorItem } from "../../core/status/doctor-service.js";
import { writeLog } from "../../core/logs/log-service.js";
import type { CliToolType } from "../../core/types.js";
import { promptConfirm } from "../prompts/prompt.js";
import { printTable } from "../output/table.js";

export async function runDoctorCommand(args: string[]): Promise<void> {
  const deep = args.includes("--deep");
  const yes = args.includes("--yes");
  const strict = args.includes("--strict");
  const local = args.includes("--local") || args.includes("--no-network");
  const fix = !args.includes("--no-fix");
  const tool = readTool(args);

  if (deep && local) {
    throw new Error("`--deep` cannot be combined with `--local` or `--no-network`.");
  }

  const result = deep
    ? await runDeep(yes, tool, fix)
    : { items: await runDoctor({ fix, checkProviders: !local }), deepPerformed: false };

  await writeLog({
    category: "usage",
    action: result.deepPerformed ? "doctor_deep" : "doctor",
    message: `Doctor completed with ${result.items.length} item(s).`,
    metadata: {
      deep: result.deepPerformed,
      tool: result.deepPerformed ? tool : null,
      fix,
      local,
      fixed: result.items.filter((item) => item.fixed).length,
      errors: result.items.filter((item) => item.status === "error").length,
      warnings: result.items.filter((item) => item.status === "warn").length
    }
  });
  printDoctorItems(result.items);

  if (strict && result.items.some((item) => item.status === "error")) {
    process.exitCode = 1;
  }
}

async function runDeep(
  yes: boolean,
  tool: CliToolType,
  fix: boolean
): Promise<{ items: DoctorItem[]; deepPerformed: boolean }> {
  if (!yes) {
    const confirmed = await promptConfirm("`ai doctor --deep` may consume tokens. Continue?");
    if (!confirmed) {
      return { items: await runDoctor({ fix }), deepPerformed: false };
    }
  }
  return { items: await runDeepDoctor(tool, { fix }), deepPerformed: true };
}

export function printDoctorItems(items: DoctorItem[]): void {
  printTable(
    items.map((item) => ({
      group: item.group,
      status: item.fixed ? "fixed" : item.status,
      message: item.message,
      next: item.suggestion ?? ""
    }))
  );
}

function readTool(args: string[]): CliToolType {
  const inline = args.find((arg) => arg.startsWith("--tool="));
  const index = args.indexOf("--tool");
  const value = inline?.slice("--tool=".length) ?? (index >= 0 ? args[index + 1] : undefined) ?? "codex";
  if (value !== "claude" && value !== "codex") {
    throw new Error("`--tool` must be `claude` or `codex`.");
  }
  return value;
}
