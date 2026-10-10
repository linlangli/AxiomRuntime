#!/usr/bin/env node
import { runAddCommand } from "./commands/add.js";
import { runCheckCommand } from "./commands/check.js";
import { runContextCommand } from "./commands/context.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runFailoverCommand } from "./commands/failover.js";
import { runProviderDeleteCommand, runProviderEditCommand } from "./commands/edit.js";
import { runHelpCommand } from "./commands/help.js";
import { runImageCommand } from "./commands/image.js";
import { runListCommand } from "./commands/list.js";
import { runLogCommand } from "./commands/log.js";
import { runMemoryCommand } from "./commands/memory.js";
import { runModelsCommand } from "./commands/models.js";
import { runProxyCommand } from "./commands/proxy.js";
import { runReportCommand } from "./commands/report.js";
import { runLastCommand, runUseCommand } from "./commands/use.js";
import { runSessionCommand } from "./commands/session.js";
import { runSetCommand } from "./commands/set.js";
import { runSetupCommand } from "./commands/setup.js";
import { runStatusCommand } from "./commands/status.js";
import { runTelegramCommand } from "./commands/telegram.js";
import { runVersionCommand } from "./commands/version.js";
import { runWebCommand } from "./commands/web.js";
import { writeLog } from "../core/logs/log-service.js";
import { promptSelect } from "./prompts/prompt.js";
import { getCliCommand, registerCliCommand } from "./registry.js";
import { redactCodexProxyCommandArgs } from "./sanitize-args.js";
import { loadRuntimeConfig } from "../core/config/runtime-config.js";
import { configureGlobalProxy } from "../core/network/proxy.js";

registerBuiltInCommands();

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command !== "proxy") {
    const runtimeConfig = await loadRuntimeConfig();
    if (runtimeConfig.proxyUrl) configureGlobalProxy(runtimeConfig.proxyUrl);
  }
  const registered = command === undefined ? undefined : getCliCommand(command);
  if (registered?.logUsage === false) {
    await registered.run(args);
    return;
  }

  const safeArgs = sanitizeArgs(command, args);
  await writeLog({
    category: "usage",
    action: "command_start",
    message: `Command started: ${command ?? "interactive"}`,
    metadata: { command: command ?? "interactive", args: safeArgs }
  });

  if (command === undefined) {
    await runInteractive();
    return;
  }

  if (registered) {
    await registered.run(args);
    return;
  }

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

export function sanitizeArgs(command: string | undefined, args: string[]): string[] {
  if (command === "proxy" && args.length) return ["[proxy-redacted]"];
  const redactedProxyArgs = redactCodexProxyCommandArgs(command, args);
  if (redactedProxyArgs) return redactedProxyArgs;
  if (command === "add" && args.length >= 3) {
    return [args[0]!, args[1]!, maskSecretArg(args[2]!)];
  }
  if (command === "provider" && args[0] === "add" && args.length >= 4) {
    return [args[0]!, args[1]!, args[2]!, maskSecretArg(args[3]!)];
  }
  if (command === "memory" && (args[0] === "embedding" || args[0] === "vector") && (args[1] === "set" || args[1] === "edit")) {
    return maskMemoryEmbeddingSetArgs(args);
  }
  if (command === "telegram") {
    return maskTelegramConfigSecretArgs(args);
  }
  if (command === "image" && args.length > 1) {
    return [args[0]!, `[prompt ${args.slice(1).join(" ").length} chars]`];
  }
  return args.map((arg, index) => {
    const previous = args[index - 1]?.toLowerCase();
    if (previous === "--api-key" || previous === "--apikey" || previous === "--key") {
      return maskSecretArg(arg);
    }
    return arg;
  });
}

function maskTelegramConfigSecretArgs(args: string[]): string[] {
  const masked = [...args];
  let state: "config" | "set" | "token" | "done" = "config";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--bot") {
      index += 1;
      continue;
    }
    if (arg === "--all" || arg.startsWith("--bot=")) continue;
    if (state === "config" && arg === "config") { state = "set"; continue; }
    if (state === "set" && arg === "set") { state = "token"; continue; }
    if (state === "token" && (arg === "token" || arg === "proxyUrl")) { state = "done"; continue; }
    if (state === "done") {
      masked[index] = maskSecretArg(arg);
      break;
    }
  }
  return masked;
}

function maskMemoryEmbeddingSetArgs(args: string[]): string[] {
  const valueOptions = new Set(["--type", "--provider-type", "--query-task", "--passage-task", "--dimensions", "--api-key", "--apikey", "--key"]);
  const masked = [...args];
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--")) continue;
    const previous = args[index - 1]?.toLowerCase();
    if (previous === "--api-key" || previous === "--apikey" || previous === "--key") {
      masked[index] = maskSecretArg(arg);
      continue;
    }
    if (previous && valueOptions.has(previous)) continue;
    if (index >= 2) {
      positional += 1;
      if (positional === 3) masked[index] = maskSecretArg(arg);
    }
  }
  return masked;
}

function maskSecretArg(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

async function runInteractive(): Promise<void> {
  const interactiveCommandNames = ["setup", "use", "image", "set", "proxy", "failover", "add", "memory", "telegram", "models", "check", "status", "session", "report", "doctor", "log", "context", "help", "last"];
  const command = await promptSelect("AI Gateway", [
    ...interactiveCommandNames
      .flatMap((name) => {
        const item = getCliCommand(name);
        return item ? [{ label: item.description, value: item.name }] : [];
      }),
    { label: "provider list", value: "provider:list" },
    { label: "provider edit", value: "provider:edit" },
    { label: "provider delete", value: "provider:delete" },
    { label: "exit", value: "exit" }
  ]);

  if (command === "exit") return;
  if (command === "provider:list") await runListCommand();
  if (command === "provider:edit") await runProviderEditCommand();
  if (command === "provider:delete") await runProviderDeleteCommand();
  const registered = getCliCommand(command);
  if (registered) await registered.run([]);
}

async function runProviderCommand(args: string[]): Promise<void> {
  const [subcommand, name] = args;
  if (subcommand === "add") {
    await runAddCommand(args.slice(1));
    return;
  }
  if (subcommand === "list") {
    await runListCommand();
    return;
  }
  if (subcommand === "edit") {
    await runProviderEditCommand(name);
    return;
  }
  if (subcommand === "delete" || subcommand === "remove") {
    await runProviderDeleteCommand(name);
    return;
  }
  throw new Error(`Unknown provider command: ${subcommand ?? "(missing)"}`);
}

function registerBuiltInCommands(): void {
  registerCliCommand({
    name: "version",
    aliases: ["--version", "-v", "-V"],
    description: "version",
    interactive: false,
    logUsage: false,
    run: () => runVersionCommand()
  });
  registerCliCommand({
    name: "setup",
    description: "setup",
    run: (args) => runSetupCommand(args)
  });
  registerCliCommand({
    name: "help",
    description: "help",
    run: () => runHelpCommand()
  });
  registerCliCommand({
    name: "add",
    description: "provider add",
    run: (args) => runAddCommand(args)
  });
  registerCliCommand({
    name: "models",
    description: "list provider models",
    run: (args) => runModelsCommand(args)
  });
  registerCliCommand({
    name: "check",
    description: "check provider",
    run: (args) => runCheckCommand(args)
  });
  registerCliCommand({
    name: "status",
    description: "status",
    run: () => runStatusCommand()
  });
  registerCliCommand({
    name: "provider",
    description: "provider add",
    interactive: false,
    run: (args) => runProviderCommand(args)
  });
  registerCliCommand({
    name: "session",
    description: "session",
    run: (args) => runSessionCommand(args)
  });
  registerCliCommand({
    name: "report",
    description: "report",
    run: (args) => runReportCommand(args)
  });
  registerCliCommand({
    name: "log",
    description: "log",
    run: (args) => runLogCommand(args)
  });
  registerCliCommand({
    name: "context",
    description: "context",
    run: (args) => runContextCommand(args)
  });
  registerCliCommand({
    name: "telegram",
    description: "telegram",
    run: (args) => runTelegramCommand(args)
  });
  registerCliCommand({
    name: "memory",
    description: "memory",
    run: (args) => runMemoryCommand(args)
  });
  registerCliCommand({
    name: "doctor",
    description: "doctor",
    run: (args) => runDoctorCommand(args)
  });
  registerCliCommand({
    name: "use",
    description: "use",
    run: (args) => runUseCommand(args)
  });
  registerCliCommand({
    name: "image",
    description: "generate image",
    run: (args) => runImageCommand(args)
  });
  registerCliCommand({
    name: "set",
    description: "set Codex provider or proxy",
    run: (args) => runSetCommand(args)
  });
  registerCliCommand({
    name: "proxy",
    description: "configure AI Runtime proxy",
    run: (args) => runProxyCommand(args)
  });
  registerCliCommand({
    name: "failover",
    description: "toggle provider auto-failover",
    run: (args) => runFailoverCommand(args)
  });
  registerCliCommand({
    name: "last",
    description: "last",
    run: () => runLastCommand()
  });
  registerCliCommand({
    name: "web",
    description: "Open the local Web control panel",
    interactive: false,
    run: runWebCommand
  });
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
