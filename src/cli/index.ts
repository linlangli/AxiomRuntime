#!/usr/bin/env node
import { runAddCommand } from "./commands/add.js";
import { runContextCommand } from "./commands/context.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runEditCommand } from "./commands/edit.js";
import { runHelpCommand } from "./commands/help.js";
import { runHermesCommand } from "./commands/hermes.js";
import { runListCommand } from "./commands/list.js";
import { runLogCommand } from "./commands/log.js";
import { runReportCommand } from "./commands/report.js";
import { runLastCommand, runUseCommand } from "./commands/use.js";
import { runSessionCommand } from "./commands/session.js";
import { runStatusCommand } from "./commands/status.js";
import { writeLog } from "../core/logs/log-service.js";
import { promptSelect } from "./prompts/prompt.js";

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const safeArgs = sanitizeArgs(command, args);
  await writeLog({
    category: "usage",
    action: "command_start",
    message: `Command started: ${command ?? "interactive"}`,
    metadata: { command: command ?? "interactive", args: safeArgs }
  });

  switch (command) {
    case undefined:
      await runInteractive();
      break;
    case "help":
      await runHelpCommand();
      break;
    case "add":
      await runAddCommand(args);
      break;
    case "edit":
      await runEditCommand();
      break;
    case "status":
      await runStatusCommand();
      break;
    case "provider":
      await runProviderCommand(args);
      break;
    case "session":
      await runSessionCommand(args);
      break;
    case "report":
      await runReportCommand(args);
      break;
    case "log":
      await runLogCommand(args);
      break;
    case "context":
      await runContextCommand(args);
      break;
    case "hermes":
      await runHermesCommand(args);
      break;
    case "doctor":
      await runDoctorCommand(args);
      break;
    case "use":
      await runUseCommand(args);
      break;
    case "last":
      await runLastCommand();
      break;
    case "web":
      console.log("`ai web` is planned but not implemented in this foundation build.");
      break;
    default:
      await writeLog({
        level: "warn",
        category: "usage",
        action: "unknown_command",
        message: `Unknown command: ${command}`,
        metadata: { command, args: safeArgs }
      });
      console.error(`Unknown command: ${command}`);
      console.error("Run `ai help` for usage.");
      process.exitCode = 1;
  }
}

function sanitizeArgs(command: string | undefined, args: string[]): string[] {
  if (command === "add" && args.length >= 3) {
    return [args[0]!, args[1]!, maskSecretArg(args[2]!)];
  }
  return args.map((arg, index) => {
    const previous = args[index - 1]?.toLowerCase();
    if (previous === "--api-key" || previous === "--apikey" || previous === "--key") {
      return maskSecretArg(arg);
    }
    return arg;
  });
}

function maskSecretArg(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

async function runInteractive(): Promise<void> {
  const command = await promptSelect("AI Gateway", [
    { label: "use", value: "use" },
    { label: "add", value: "add" },
    { label: "edit", value: "edit" },
    { label: "provider list", value: "provider:list" },
    { label: "hermes", value: "hermes" },
    { label: "status", value: "status" },
    { label: "session", value: "session" },
    { label: "report", value: "report" },
    { label: "doctor", value: "doctor" },
    { label: "log", value: "log" },
    { label: "context", value: "context" },
    { label: "help", value: "help" },
    { label: "last", value: "last" },
    { label: "exit", value: "exit" }
  ]);

  if (command === "use") await runUseCommand([]);
  if (command === "add") await runAddCommand([]);
  if (command === "edit") await runEditCommand();
  if (command === "provider:list") await runListCommand();
  if (command === "hermes") await runHermesCommand([]);
  if (command === "status") await runStatusCommand();
  if (command === "session") await runSessionCommand([]);
  if (command === "report") await runReportCommand([]);
  if (command === "doctor") await runDoctorCommand([]);
  if (command === "log") await runLogCommand([]);
  if (command === "context") await runContextCommand([]);
  if (command === "help") await runHelpCommand();
  if (command === "last") await runLastCommand();
}

async function runProviderCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "list") {
    await runListCommand();
    return;
  }
  throw new Error(`Unknown provider command: ${subcommand ?? "(missing)"}`);
}

main().catch(async (error) => {
  await writeLog({
    level: "error",
    category: "error",
    action: "command_error",
    message: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
