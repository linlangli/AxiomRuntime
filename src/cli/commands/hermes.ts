import path from "node:path";
import { getHermesRobotsPath } from "../../core/config/paths.js";
import {
  addHermesRobot,
  clearHermesRobot,
  deleteHermesRobot,
  exportHermesRobot,
  getHermesRobotStatuses,
  importLocalHermesRobots,
  importHermesRobot,
  listHermesRobots,
  syncHermesRobotToLocalConfigAndRestart,
  updateHermesRobot,
  useHermesRobot
} from "../../core/hermes/hermes-service.js";
import { getCachedModels, listProviders } from "../../core/providers/provider-service.js";
import type { HermesRobot, HermesRobotStatus } from "../../core/hermes/hermes-types.js";
import type { Provider, ProviderMode } from "../../core/types.js";
import { promptConfirm, promptSelect, promptText } from "../prompts/prompt.js";

export async function runHermesCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case undefined:
      await runHermesInteractive();
      return;
    case "status":
      await runHermesStatusCommand();
      return;
    case "use":
      await runHermesUseCommand(rest[0]);
      return;
    case "add":
      await runHermesAddCommand();
      return;
    case "list":
      await runHermesListCommand();
      return;
    case "edit":
      await runHermesEditCommand(rest[0]);
      return;
    case "sync":
      await runHermesSyncCommand(rest[0]);
      return;
    case "clear":
      await runHermesClearCommand(rest[0]);
      return;
    case "delete":
      await runHermesDeleteCommand(rest[0]);
      return;
    case "import":
      await runHermesImportCommand(rest[0]);
      return;
    case "import-local":
      await runHermesImportLocalCommand(rest.includes("--overwrite"));
      return;
    case "export":
      await runHermesExportCommand(rest[0]);
      return;
    default:
      throw new Error(`Unknown hermes command: ${subcommand}`);
  }
}

async function runHermesInteractive(): Promise<void> {
  const command = await promptSelect("Hermes", [
    { label: "status", value: "status" },
    { label: "use", value: "use" },
    { label: "add", value: "add" },
    { label: "list", value: "list" },
    { label: "edit", value: "edit" },
    { label: "sync local config", value: "sync" },
    { label: "clear", value: "clear" },
    { label: "delete", value: "delete" },
    { label: "import", value: "import" },
    { label: "import local", value: "import-local" },
    { label: "export", value: "export" },
    { label: "exit", value: "exit" }
  ]);

  if (command === "status") await runHermesStatusCommand();
  if (command === "use") await runHermesUseCommand();
  if (command === "add") await runHermesAddCommand();
  if (command === "list") await runHermesListCommand();
  if (command === "edit") await runHermesEditCommand();
  if (command === "sync") await runHermesSyncCommand();
  if (command === "clear") await runHermesClearCommand();
  if (command === "delete") await runHermesDeleteCommand();
  if (command === "import") await runHermesImportCommand();
  if (command === "import-local") await runHermesImportLocalCommand();
  if (command === "export") await runHermesExportCommand();
}

async function runHermesAddCommand(): Promise<void> {
  const providers = await listProviders();
  if (!providers.length) {
    console.log("No providers configured. Run `ai add` first.");
    return;
  }

  const name = await promptText("Robot name");
  const provider = await selectProvider(providers);
  const model = await selectModel(provider);
  const mode = await promptSelect<ProviderMode>("Mode", [
    { label: "auto", value: "auto" },
    { label: "ask", value: "ask" }
  ]);
  const bindTelegram = await promptConfirm("Bind Telegram?", false);
  const telegram = bindTelegram
    ? {
        enabled: true,
        chatId: await promptText("Telegram chatId"),
        name: await promptText("Telegram display name")
      }
    : { enabled: false, chatId: "", name: "" };

  const robot = await addHermesRobot({
    name,
    provider: provider.name,
    model,
    mode,
    telegram
  });
  console.log(`Added Hermes robot: ${robot.name}`);
  await syncAndRestartLocalHermes(robot.name);
}

async function runHermesEditCommand(name?: string): Promise<void> {
  const robotName = name ?? (await selectRobotName("Select robot to edit"));
  const robot = (await listHermesRobots()).find((item) => item.name === robotName);
  if (!robot) {
    throw new Error(`Hermes robot not found: ${robotName}`);
  }

  const field = await promptSelect("Select field", [
    { label: "name", value: "name" },
    { label: "provider", value: "provider" },
    { label: "model", value: "model" },
    { label: "mode", value: "mode" },
    { label: "telegram", value: "telegram" }
  ]);

  if (field === "name") {
    const newName = await promptText("Robot name", { defaultValue: robot.name });
    const updated = await updateHermesRobot(robot.name, { name: newName });
    console.log(`Updated Hermes robot: ${updated.name}`);
    await syncAndRestartLocalHermes(updated.name);
    return;
  }

  if (field === "provider") {
    const providers = await listProviders();
    if (!providers.length) {
      console.log("No providers configured. Run `ai add` first.");
      return;
    }
    const provider = await selectProvider(providers);
    const model = await selectModel(provider);
    const updated = await updateHermesRobot(robot.name, { provider: provider.name, model });
    console.log(`Updated Hermes robot: ${updated.name}`);
    await syncAndRestartLocalHermes(updated.name);
    return;
  }

  if (field === "model") {
    const provider = (await listProviders()).find((item) => item.name === robot.provider);
    if (!provider) {
      throw new Error(`Provider not found: ${robot.provider}`);
    }
    const model = await selectModel(provider);
    const updated = await updateHermesRobot(robot.name, { model });
    console.log(`Updated Hermes robot: ${updated.name}`);
    await syncAndRestartLocalHermes(updated.name);
    return;
  }

  if (field === "mode") {
    const mode = await promptSelect<ProviderMode>("Mode", [
      { label: "auto", value: "auto" },
      { label: "ask", value: "ask" }
    ]);
    const updated = await updateHermesRobot(robot.name, { mode });
    console.log(`Updated Hermes robot: ${updated.name}`);
    await syncAndRestartLocalHermes(updated.name);
    return;
  }

  const bindTelegram = await promptConfirm("Enable Telegram binding?", Boolean(robot.telegram?.enabled));
  const telegram = bindTelegram
    ? {
        enabled: true,
        chatId: await promptText("Telegram chatId", { defaultValue: robot.telegram?.chatId ?? "" }),
        name: await promptText("Telegram display name", { defaultValue: robot.telegram?.name ?? "" })
      }
    : { enabled: false, chatId: "", name: "" };
  const updated = await updateHermesRobot(robot.name, { telegram });
  console.log(`Updated Hermes robot: ${updated.name}`);
  await syncAndRestartLocalHermes(updated.name);
}

async function runHermesListCommand(): Promise<void> {
  const robots = await listHermesRobots();
  if (!robots.length) {
    console.log("No Hermes robots configured. Run `ai hermes add` first.");
    console.log("If you already use local Hermes, run `ai hermes import-local` to import existing Hermes config.");
    return;
  }

  console.log(`Hermes Robots (${robots.length})`);
  console.log(`Config: ${getHermesRobotsPath()}`);
  console.log("=".repeat(72));
  robots.forEach((robot, index) => {
    printRobotCard(robot);
    if (index < robots.length - 1) console.log("");
  });
}

async function runHermesStatusCommand(): Promise<void> {
  const statuses = await getHermesRobotStatuses({ refreshProviders: true });
  if (!statuses.length) {
    console.log("No Hermes robots configured. Run `ai hermes add` first.");
    return;
  }

  console.log(`Hermes Status (${statuses.length})`);
  console.log(`Config: ${getHermesRobotsPath()}`);
  console.log("=".repeat(72));
  statuses.forEach((status, index) => {
    printStatusCard(status);
    if (index < statuses.length - 1) console.log("");
  });
}

export async function runHermesUseCommand(name?: string): Promise<void> {
  const robotName = name ?? (await selectRobotName("Select robot"));
  const robot = (await listHermesRobots()).find((item) => item.name === robotName);
  if (!robot) {
    throw new Error(`Hermes robot not found: ${robotName}`);
  }
  if (robot.mode === "ask") {
    const confirmed = await promptConfirm(`Start Hermes robot ${robot.name}?`);
    if (!confirmed) return;
  }
  console.log(`Using Hermes: ${robot.name} / ${robot.provider} / ${robot.model}`);
  const code = await useHermesRobot(robot.name);
  process.exitCode = code;
}

async function runHermesClearCommand(name?: string): Promise<void> {
  const robotName = name ?? (await selectRobotName("Select robot to clear"));
  const confirmed = await promptConfirm(`Clear Hermes robot ${robotName}? This keeps configuration and resets AI Gateway-managed robot state.`, false);
  if (!confirmed) return;
  await clearHermesRobot(robotName);
  console.log(`Cleared Hermes robot: ${robotName}`);
}

async function runHermesDeleteCommand(name?: string): Promise<void> {
  const robotName = name ?? (await selectRobotName("Select robot to delete"));
  const answer = await promptText(`Type ${robotName} to delete`);
  if (answer !== robotName) {
    console.log("Delete cancelled.");
    return;
  }
  await deleteHermesRobot(robotName);
  console.log(`Deleted Hermes robot: ${robotName}`);
}

async function runHermesSyncCommand(name?: string): Promise<void> {
  const robotName = name ?? (await selectRobotName("Select robot to sync"));
  await syncAndRestartLocalHermes(robotName);
}

async function syncAndRestartLocalHermes(robotName: string): Promise<void> {
  const result = await syncHermesRobotToLocalConfigAndRestart(robotName);
  console.log(`Synced local Hermes config: ${result.configPath}`);
  console.log(`Active Hermes default: ${result.robot.name} / ${result.provider.name} / ${result.robot.model}`);
  console.log(result.restart.message);
}

async function runHermesExportCommand(name?: string): Promise<void> {
  const robotName = name ?? (await selectRobotName("Select robot to export"));
  const outputPath = await exportHermesRobot(robotName);
  console.log(`Exported Hermes robot: ${outputPath}`);
}

async function runHermesImportCommand(filePath?: string): Promise<void> {
  const selectedPath = filePath ?? (await promptText("Import file path"));
  const absolutePath = path.resolve(selectedPath);

  try {
    const result = await importHermesRobot(absolutePath);
    console.log(`Imported Hermes robot: ${result.robot.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already exists")) {
      throw error;
    }

    const action = await promptSelect("Robot already exists", [
      { label: "overwrite", value: "overwrite" },
      { label: "rename", value: "rename" },
      { label: "cancel", value: "cancel" }
    ]);
    if (action === "cancel") return;
    if (action === "overwrite") {
      const result = await importHermesRobot(absolutePath, { onConflict: "overwrite" });
      console.log(`Overwrote Hermes robot: ${result.robot.name}`);
      return;
    }
    const renameTo = await promptText("New robot name");
    const result = await importHermesRobot(absolutePath, { onConflict: "rename", renameTo });
    console.log(`Imported Hermes robot as: ${result.robot.name}`);
  }
}

async function runHermesImportLocalCommand(overwrite = false): Promise<void> {
  const result = await importLocalHermesRobots({ overwrite });
  console.log(`Imported ${result.imported.length} local Hermes robot(s) from ${result.sourceDir}.`);
  if (result.skipped.length) {
    console.log(`Skipped ${result.skipped.length} existing robot(s). Use \`ai hermes import-local --overwrite\` to overwrite them.`);
  }
  if (result.imported.length) {
    console.log("");
    result.imported.forEach((robot) => {
      console.log(`- ${robot.name} -> ${robot.provider} / ${robot.model || "(none)"} / ${robot.tasks.length} task(s)`);
    });
  }
}

async function selectProvider(providers: Provider[]): Promise<Provider> {
  const name = await promptSelect("Select provider", providers.map((provider) => ({
    label: `${provider.level}. ${provider.name} (${provider.model || "no model"})`,
    value: provider.name
  })));
  return providers.find((provider) => provider.name === name)!;
}

async function selectModel(provider: Provider): Promise<string> {
  const cached = await getCachedModels(provider.name);
  const models = Array.from(new Set([provider.model, ...cached].filter(Boolean)));
  if (!models.length) {
    return promptText("Model");
  }
  return promptSelect("Select model", models.map((model) => ({ label: model, value: model })));
}

async function selectRobotName(message: string): Promise<string> {
  const robots = await listHermesRobots();
  if (!robots.length) {
    throw new Error("No Hermes robots configured. Run `ai hermes add` first.");
  }
  return promptSelect(message, robots.map((robot) => ({ label: robot.name, value: robot.name })));
}

function printRobotCard(robot: HermesRobot): void {
  const header = robot.name;
  console.log(header);
  console.log("-".repeat(Math.min(72, Math.max(24, header.length))));
  console.log(`  Provider  ${robot.provider}`);
  console.log(`  Model     ${robot.model || "(none)"}`);
  console.log(`  Mode      ${robot.mode}`);
  console.log(`  Telegram  ${formatTelegram(robot)}`);
  console.log(`  Tasks     ${formatTasksSummary(robot)}`);
  printTasks(robot);
}

function printStatusCard(status: HermesRobotStatus): void {
  const header = `${status.robot.name}  status:${status.status}`;
  console.log(header);
  console.log("-".repeat(Math.min(72, Math.max(24, header.length))));
  console.log(`  Hermes    ${status.hermesCli}`);
  console.log(`  Provider  ${status.robot.provider} (${status.providerHealth})`);
  console.log(`  Model     ${status.robot.model} (${formatModelAvailable(status.modelAvailable)})`);
  console.log(`  Mode      ${status.robot.mode}`);
  console.log(`  Telegram  ${formatTelegram(status.robot)} (${status.telegram})`);
  console.log(`  Tasks     ${formatTasksSummary(status.robot)}`);
  printTasks(status.robot);
  console.log(`  Last Used ${status.lastUsedAt ?? "(never)"}`);
  if (status.lastError) console.log(`  Last Err  ${status.lastError}`);
  for (const note of status.notes) {
    console.log(`  Note      ${note}`);
  }
}

function formatTelegram(robot: HermesRobot): string {
  if (!robot.telegram.enabled) return "(missing)";
  const name = robot.telegram.name || "(unnamed)";
  const chatId = robot.telegram.chatId || "(missing chatId)";
  return `${name} / ${chatId}`;
}

function formatModelAvailable(value: HermesRobotStatus["modelAvailable"]): string {
  if (value === "unknown") return "unknown";
  return value ? "available" : "missing";
}

function formatTasksSummary(robot: HermesRobot): string {
  if (!robot.tasks.length) return "0";
  const active = robot.tasks.filter((task) => task.enabled).length;
  return `${robot.tasks.length} (${active} active)`;
}

function printTasks(robot: HermesRobot): void {
  if (!robot.tasks.length) return;
  const preview = robot.tasks.slice(0, 5);
  for (const task of preview) {
    const state = task.enabled ? task.state || "enabled" : task.state || "disabled";
    const runtime = task.provider || task.model ? ` -> ${task.provider || robot.provider} / ${task.model || robot.model}` : "";
    console.log(`    - ${task.name} [${state}]${runtime}`);
  }
  if (robot.tasks.length > preview.length) {
    console.log(`    ... ${robot.tasks.length - preview.length} more task(s)`);
  }
}
