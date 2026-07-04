#!/usr/bin/env node
import { runAddCommand } from "./commands/add.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runEditCommand } from "./commands/edit.js";
import { runHelpCommand } from "./commands/help.js";
import { runListCommand } from "./commands/list.js";
import { runLastCommand, runUseCommand } from "./commands/use.js";
import { runStatusCommand } from "./commands/status.js";
import { promptSelect } from "./prompts/prompt.js";

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

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
    case "list":
      await runListCommand();
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
      console.error(`Unknown command: ${command}`);
      console.error("Run `ai help` for usage.");
      process.exitCode = 1;
  }
}

async function runInteractive(): Promise<void> {
  const command = await promptSelect("AI Gateway", [
    { label: "use", value: "use" },
    { label: "add", value: "add" },
    { label: "edit", value: "edit" },
    { label: "list", value: "list" },
    { label: "status", value: "status" },
    { label: "doctor", value: "doctor" },
    { label: "help", value: "help" },
    { label: "last", value: "last" },
    { label: "exit", value: "exit" }
  ]);

  if (command === "use") await runUseCommand([]);
  if (command === "add") await runAddCommand([]);
  if (command === "edit") await runEditCommand();
  if (command === "list") await runListCommand();
  if (command === "status") await runStatusCommand();
  if (command === "doctor") await runDoctorCommand([]);
  if (command === "help") await runHelpCommand();
  if (command === "last") await runLastCommand();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
