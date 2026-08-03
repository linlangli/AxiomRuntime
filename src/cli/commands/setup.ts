import { spawn } from "node:child_process";
import { readProviders } from "../../core/config/providers-store.js";
import { writeLog } from "../../core/logs/log-service.js";
import { resolveToolCommand } from "../../core/runner/command-resolver.js";
import { runDoctor } from "../../core/status/doctor-service.js";
import type { CliToolType } from "../../core/types.js";
import { promptConfirm } from "../prompts/prompt.js";
import { runAddCommand } from "./add.js";
import { printDoctorItems } from "./doctor.js";

const TOOL_PACKAGES: Record<CliToolType, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex"
};

export async function runSetupCommand(args: string[]): Promise<void> {
  const yes = args.includes("--yes");
  const installTools = args.includes("--install-tools");
  const skipProvider = args.includes("--skip-provider");
  const skipTools = args.includes("--skip-tools");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !yes;

  console.log("Preparing Axiom Runtime...");
  const initialItems = await runDoctor({ fix: true, checkProviders: false });
  printDoctorItems(initialItems);

  let providers = await readProviders();
  if (!providers.length && !skipProvider) {
    const configureProvider = interactive
      ? await promptConfirm("No provider is configured. Configure one now?", true)
      : false;
    if (configureProvider) {
      await runAddCommand([]);
      providers = await readProviders();
    } else {
      console.log("Provider setup skipped. Run `ai provider add` when credentials are available.");
    }
  }

  const missingTools = (["claude", "codex"] as CliToolType[]).filter((tool) => !resolveToolCommand(tool));
  if (missingTools.length && !skipTools) {
    const authorized = installTools || (interactive && await promptConfirm(
      `Install missing CLIs (${missingTools.join(", ")}) with npm?`,
      false
    ));
    if (authorized) {
      for (const tool of missingTools) {
        try {
          await installTool(tool);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          console.error(`Install ${TOOL_PACKAGES[tool]} manually, then re-run \`ai doctor --local\`.`);
        }
      }
    } else {
      console.log("External CLI installation skipped. Re-run with `ai setup --install-tools` to install them.");
    }
  }

  const finalItems = await runDoctor({ fix: true, checkProviders: providers.length > 0 });
  console.log("\nSetup result");
  printDoctorItems(finalItems);

  const errors = finalItems.filter((item) => item.status === "error").length;
  const warnings = finalItems.filter((item) => item.status === "warn").length;
  console.log(errors
    ? `Setup completed with ${errors} error(s) and ${warnings} warning(s). Follow the suggested next steps above.`
    : warnings
      ? `Setup completed with ${warnings} optional warning(s).`
      : "Setup completed. Axiom Runtime is ready.");

  await writeLog({
    category: "usage",
    action: "setup",
    message: `Setup completed with ${errors} error(s) and ${warnings} warning(s).`,
    metadata: { errors, warnings, providerCount: providers.length, installTools, skipProvider, skipTools }
  });
}

async function installTool(tool: CliToolType): Promise<void> {
  const packageName = TOOL_PACKAGES[tool];
  console.log(`Installing ${packageName}...`);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const exitCode = await spawnInherited(npmCommand, ["install", "--global", packageName]);
  if (exitCode !== 0) {
    throw new Error(`Failed to install ${packageName} (exit code ${exitCode}).`);
  }
  console.log(`Installed ${packageName}.`);
}

function spawnInherited(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
