import { readCache } from "../../core/config/cache-store.js";
import { writeLog } from "../../core/logs/log-service.js";
import { refreshAllProviders } from "../../core/providers/provider-service.js";
import { resolveProviderForTool } from "../../core/runner/fallback.js";
import { runTool } from "../../core/runner/tool-runner.js";
import type { ToolType } from "../../core/types.js";
import { promptConfirm, promptSelect } from "../prompts/prompt.js";

export async function runUseCommand(args: string[]): Promise<void> {
  const tool = await getTool(args[0]);
  const providerName = args[1];
  const modelName = args[2];

  await refreshAllProviders();
  const resolved = await resolveProviderForTool(tool, providerName, modelName);

  if (resolved.fallbackFrom) {
    console.log(`Provider ${resolved.fallbackFrom} unavailable, fallback to ${resolved.provider.name}.`);
    await writeLog({
      category: "strategy",
      action: "fallback_applied",
      message: `Provider ${resolved.fallbackFrom} unavailable, fallback to ${resolved.provider.name}.`,
      metadata: { from: resolved.fallbackFrom, to: resolved.provider.name, tool, model: resolved.model }
    });
  }

  console.log(`Using ${tool}: ${resolved.provider.name} / ${resolved.model}`);
  await writeLog({
    category: "usage",
    action: "tool_start",
    message: `Starting ${tool}: ${resolved.provider.name} / ${resolved.model}`,
    metadata: { tool, provider: resolved.provider.name, model: resolved.model, mode: resolved.provider.mode }
  });
  if (resolved.provider.mode === "ask") {
    const confirmed = await promptConfirm("Start CLI?");
    if (!confirmed) return;
  }

  const code = await runTool(tool, resolved.provider, resolved.model, {
    fallbackFrom: resolved.fallbackFrom ?? null
  });
  process.exitCode = code;
}

export async function runLastCommand(): Promise<void> {
  const cache = await readCache();
  if (!cache.lastSelection) {
    console.log("No last selection found.");
    return;
  }
  await runUseCommand([cache.lastSelection.tool, cache.lastSelection.provider, cache.lastSelection.model]);
}

async function getTool(value?: string): Promise<ToolType> {
  if (value === "claude" || value === "codex") {
    return value;
  }
  return promptSelect<ToolType>("Select tool", [
    { label: "claude", value: "claude" },
    { label: "codex", value: "codex" }
  ]);
}
