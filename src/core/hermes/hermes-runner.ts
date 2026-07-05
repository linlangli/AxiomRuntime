import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveToolCommand } from "../runner/command-resolver.js";
import { getSecretFingerprint, getToolBaseUrl } from "../runner/tool-runner.js";
import { startSession, finishSession } from "../sessions/session-service.js";
import { writeLog } from "../logs/log-service.js";
import type { Provider } from "../types.js";
import type { HermesRobot } from "./hermes-types.js";
import { getHermesRobotHome, upsertHermesRobotState } from "./hermes-store.js";

export type HermesLaunchPlan = {
  command: string;
  args: string[];
  providerKind: "anthropic" | "auto";
  baseUrl: string;
};

export type HermesRuntime = {
  env: NodeJS.ProcessEnv;
  hermesHome: string;
  configPath: string;
};

export function getHermesCommand(): string | null {
  return resolveToolCommand("hermes");
}

export function isHermesInstalled(): boolean {
  return Boolean(getHermesCommand());
}

export function buildHermesLaunchPlan(robot: HermesRobot, provider: Provider): HermesLaunchPlan {
  const command = getHermesCommand();
  if (!command) {
    throw new Error("Failed to find Hermes CLI. Install Hermes or add it to PATH.");
  }

  const providerKind = isClaudeModel(robot.model) ? "anthropic" : "auto";
  const baseUrl = isClaudeModel(robot.model) ? getToolBaseUrl("claude", provider) : getToolBaseUrl("codex", provider);
  return {
    command,
    args: ["chat", "--model", robot.model, "--provider", providerKind, "--source", `ai-gateway:${robot.name}`],
    providerKind,
    baseUrl
  };
}

export async function runHermesRobot(robot: HermesRobot, provider: Provider): Promise<number> {
  const plan = buildHermesLaunchPlan(robot, provider);
  const runtime = await prepareHermesRuntime(robot, provider, plan);

  await writeLog({
    category: "usage",
    action: "hermes_spawn",
    message: `Spawning Hermes robot ${robot.name}: ${provider.name} / ${robot.model}`,
    metadata: {
      robot: robot.name,
      provider: provider.name,
      model: robot.model,
      mode: robot.mode,
      baseUrl: plan.baseUrl,
      configuredBaseUrl: provider.baseUrl,
      apiKeyFingerprint: getSecretFingerprint(provider.apiKey),
      command: plan.command,
      args: plan.args,
      authInjection: "isolated HERMES_HOME config + process env",
      hermesHome: runtime.hermesHome
    }
  });

  const session = await startSession({
    tool: "hermes",
    provider,
    model: robot.model,
    projectPath: process.cwd(),
    fallbackFrom: null,
    hermesRobot: robot.name
  });
  await upsertHermesRobotState(robot.name, {
    lastUsedAt: new Date().toISOString(),
    lastSessionId: session.id,
    lastError: null
  });

  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      stdio: "inherit",
      env: runtime.env
    });

    child.on("error", (error) => {
      void finishSession(session.id, 1);
      void upsertHermesRobotState(robot.name, { lastError: error.message });
      reject(new Error(`Failed to start Hermes. ${error.message}`));
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      void finishSession(session.id, exitCode)
        .then(() => upsertHermesRobotState(robot.name, { lastError: exitCode === 0 ? null : `Hermes exited with code ${exitCode}` }))
        .finally(() => resolve(exitCode));
    });
  });
}

export async function prepareHermesRuntime(robot: HermesRobot, provider: Provider, plan = buildHermesLaunchPlan(robot, provider)): Promise<HermesRuntime> {
  const hermesHome = getHermesRobotHome(robot.name);
  const configPath = path.join(hermesHome, "config.yaml");
  await writeHermesRuntimeConfig(configPath, robot, provider, plan);

  return {
    env: buildHermesEnv(robot, provider, plan.baseUrl, hermesHome),
    hermesHome,
    configPath
  };
}

async function writeHermesRuntimeConfig(configPath: string, robot: HermesRobot, provider: Provider, plan: HermesLaunchPlan): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, buildHermesRuntimeConfig(robot, provider, plan), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(path.dirname(configPath), 0o700).catch(() => undefined);
  await fs.chmod(configPath, 0o600).catch(() => undefined);
}

function buildHermesRuntimeConfig(robot: HermesRobot, provider: Provider, plan: HermesLaunchPlan): string {
  return [
    "model:",
    `  default: ${yamlString(robot.model)}`,
    `  provider: ${yamlString(plan.providerKind)}`,
    `  base_url: ${yamlString(plan.baseUrl)}`,
    `  api_key: ${yamlString(provider.apiKey)}`,
    "toolsets:",
    "  - hermes-cli",
    "agent:",
    "  max_turns: 90",
    "  gateway_timeout: 1800",
    ""
  ].join("\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function buildHermesEnv(robot: HermesRobot, provider: Provider, baseUrl: string, hermesHome: string): NodeJS.ProcessEnv {
  const common = {
    ...process.env,
    HERMES_HOME: hermesHome,
    AI_GATEWAY_PROVIDER: provider.name,
    AI_GATEWAY_MODEL: robot.model,
    AI_GATEWAY_MODE: robot.mode,
    AI_GATEWAY_BASE_URL: baseUrl,
    AI_GATEWAY_HERMES_ROBOT: robot.name
  };

  if (isClaudeModel(robot.model)) {
    return {
      ...common,
      ANTHROPIC_API_KEY: provider.apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: robot.model
    };
  }

  return {
    ...common,
    OPENAI_API_KEY: provider.apiKey,
    OPENAI_BASE_URL: baseUrl,
    OPENAI_MODEL: robot.model
  };
}

function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes("claude");
}
