import { runDeepDoctor, runDoctor, type DoctorItem } from "../../core/status/doctor-service.js";
import { writeLog } from "../../core/logs/log-service.js";
import { promptConfirm } from "../prompts/prompt.js";
import { printTable } from "../output/table.js";

export async function runDoctorCommand(args: string[]): Promise<void> {
  const deep = args.includes("--deep");
  const yes = args.includes("--yes");
  const items = deep ? await runDeep(yes) : await runDoctor();
  await writeLog({
    category: "usage",
    action: deep ? "doctor_deep" : "doctor",
    message: `Doctor completed with ${items.length} item(s).`,
    metadata: { deep, errors: items.filter((item) => item.status === "error").length, warnings: items.filter((item) => item.status === "warn").length }
  });
  printDoctor(items);
}

async function runDeep(yes: boolean): Promise<DoctorItem[]> {
  if (!yes) {
    const confirmed = await promptConfirm("`ai doctor --deep` may consume tokens. Continue?");
    if (!confirmed) {
      return runDoctor();
    }
  }
  return runDeepDoctor();
}

function printDoctor(items: DoctorItem[]): void {
  printTable(
    items.map((item) => ({
      group: item.group,
      status: item.status,
      message: item.message
    }))
  );
}
