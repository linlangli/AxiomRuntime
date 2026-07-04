import { spawn } from "node:child_process";
import { saveLastSelection } from "../config/cache-store.js";
import type { Provider, ToolType } from "../types.js";
import { resolveToolCommand } from "./command-resolver.js";
import { finishSession, startSession } from "../sessions/session-service.js";

export async function runTool(tool: ToolType, provider: Provider, model: string, options: { fallbackFrom?: string | null } = {}): Promise<number> {
  await saveLastSelection(tool, provider.name, model);
  const command = resolveToolCommand(tool);
  if (!command) {
    throw new Error(`Failed to find ${tool} CLI. Run \`ai doctor\` to check local CLI installation.`);
  }
  const env = buildRunnerEnv(tool, provider, model);
  const session = await startSession({
    tool,
    provider,
    model,
    projectPath: process.cwd(),
    fallbackFrom: options.fallbackFrom ?? null
  });

  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      stdio: "inherit",
      env
    });

    child.on("error", (error) => {
      void finishSession(session.id, 1);
      reject(new Error(`Failed to start ${command}. Run \`ai doctor\` to check local CLI installation. ${error.message}`));
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      void finishSession(session.id, exitCode).finally(() => resolve(exitCode));
    });
  });
}

function buildRunnerEnv(tool: ToolType, provider: Provider, model: string): NodeJS.ProcessEnv {
  const common = {
    ...process.env,
    AI_GATEWAY_PROVIDER: provider.name,
    AI_GATEWAY_MODEL: model,
    AI_GATEWAY_MODE: provider.mode
  };

  if (tool === "claude") {
    return {
      ...common,
      ANTHROPIC_API_KEY: provider.apiKey,
      ANTHROPIC_BASE_URL: provider.baseUrl,
      ANTHROPIC_MODEL: model
    };
  }

  return {
    ...common,
    OPENAI_API_KEY: provider.apiKey,
    OPENAI_BASE_URL: provider.baseUrl,
    OPENAI_MODEL: model,
    CODEX_MODEL: model
  };
}
