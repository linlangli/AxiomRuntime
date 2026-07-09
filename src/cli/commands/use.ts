import { readCache } from "../../core/config/cache-store.js";
import { writeLog } from "../../core/logs/log-service.js";
import { refreshAllProviders } from "../../core/providers/provider-service.js";
import { resolveProviderCandidatesForTool, type ResolvedRun } from "../../core/runner/fallback.js";
import { runTool } from "../../core/runner/tool-runner.js";
import type { CliToolType } from "../../core/types.js";
import { runHermesUseCommand } from "./hermes.js";
import { promptConfirm, promptSelect } from "../prompts/prompt.js";

export async function runUseCommand(args: string[]): Promise<void> {
  if (args[0] === "hermes") {
    await runHermesUseCommand(args[1]);
    return;
  }

  const tool = await getTool(args[0]);
  const providerName = args[1];
  const modelName = args[2];

  await refreshAllProviders();
  const candidates = await resolveProviderCandidatesForTool(tool, providerName, modelName);
  if (!candidates.length) {
    throw new Error("No usable provider/model found. Run `ai status` or `ai doctor`.");
  }
  const code = await runResolvedProviderCandidates(tool, candidates, {
    confirm: promptConfirm,
    runner: (candidate, fallbackFrom) => runTool(tool, candidate.provider, candidate.model, { fallbackFrom })
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

async function getTool(value?: string): Promise<CliToolType> {
  if (value === "claude" || value === "codex") {
    return value;
  }
  return promptSelect<CliToolType>("Select tool", [
    { label: "claude", value: "claude" },
    { label: "codex", value: "codex" }
  ]);
}

export type RunResolvedProviderCandidatesOptions = {
  confirm?: (message: string) => Promise<boolean>;
  runner?: (candidate: ResolvedRun, fallbackFrom: string | null) => Promise<number>;
};

export async function runResolvedProviderCandidates(
  tool: CliToolType,
  candidates: ResolvedRun[],
  options: RunResolvedProviderCandidatesOptions = {}
): Promise<number> {
  const confirm = options.confirm ?? promptConfirm;
  const runner = options.runner ?? ((candidate, fallbackFrom) =>
    runTool(tool, candidate.provider, candidate.model, { fallbackFrom }));
  let lastExitCode = 1;
  let runtimeFallbackFrom: string | null = null;
  for (const [index, candidate] of candidates.entries()) {
    const fallbackFrom = runtimeFallbackFrom ?? candidate.fallbackFrom ?? null;
    if (fallbackFrom) {
      console.log(`Provider ${fallbackFrom} unavailable, fallback to ${candidate.provider.name}.`);
      await writeProviderFallbackLog({
        action: "fallback_applied",
        from: fallbackFrom,
        to: candidate.provider.name,
        tool,
        model: candidate.model
      });
    }

    console.log(`Using ${tool}: ${candidate.provider.name} / ${candidate.model}`);
    await writeLog({
      category: "usage",
      action: "tool_start",
      message: `Starting ${tool}: ${candidate.provider.name} / ${candidate.model}`,
      metadata: { tool, provider: candidate.provider.name, model: candidate.model, mode: candidate.provider.mode }
    });
    if (candidate.provider.mode === "ask") {
      const confirmed = await confirm("Start CLI?");
      if (!confirmed) return 0;
    }

    const code = await runner(candidate, fallbackFrom);
    if (code === 0) {
      return 0;
    }

    lastExitCode = code;
    const next = candidates[index + 1];
    if (next) {
      runtimeFallbackFrom = candidate.provider.name;
      await writeProviderFallbackLog({
        level: "warn",
        action: "runtime_fallback_retry",
        from: candidate.provider.name,
        to: next.provider.name,
        tool,
        model: candidate.model,
        nextModel: next.model,
        error: `exit_code_${code}`
      });
      console.log(`Provider ${candidate.provider.name} failed with exit code ${code}, trying ${next.provider.name}.`);
    }
  }
  return lastExitCode;
}

async function writeProviderFallbackLog(input: {
  level?: "info" | "warn" | "error";
  action: string;
  from: string;
  to: string;
  tool: CliToolType;
  model: string;
  nextModel?: string;
  error?: string;
}): Promise<void> {
  await writeLog({
    level: input.level,
    category: "strategy",
    action: input.action,
    message: `Provider fallback ${input.from} -> ${input.to} for ${input.tool}.`,
    metadata: {
      from: input.from,
      to: input.to,
      engine: input.tool,
      model: input.model,
      nextModel: input.nextModel ?? null,
      error: input.error ?? null
    }
  });
}
