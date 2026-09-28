import { readCache, recordProviderRuntimeFailure, recordProviderRuntimeSuccess } from "../../core/config/cache-store.js";
import { newTraceId, writeLog } from "../../core/logs/log-service.js";
import { refreshAllProviders } from "../../core/providers/provider-service.js";
import { resolveProviderCandidatesForTool, type ResolvedRun } from "../../core/runner/fallback.js";
import { runTool } from "../../core/runner/tool-runner.js";
import type { CliToolType } from "../../core/types.js";
import { promptConfirm, promptSelect } from "../prompts/prompt.js";

export async function runUseCommand(args: string[]): Promise<void> {
  const tool = await getTool(args[0]);
  const providerName = args[1];
  const modelName = args[2];

  await refreshAllProviders();
  // 一次 `ai use` 是一条调用链路：解析跳过与后续每次切换共享同一个 traceId。
  const traceId = newTraceId();
  const candidates = await resolveProviderCandidatesForTool(tool, providerName, modelName, traceId);
  if (!candidates.length) {
    throw new Error("No usable provider/model found. Run `ai status` or `ai doctor`.");
  }
  const [initial, ...fallbacks] = candidates;
  const code = await runResolvedProviderCandidates(tool, [initial!], {
    confirm: promptConfirm,
    traceId,
    runner: (candidate, fallbackFrom) => runTool(tool, candidate.provider, candidate.model, {
      fallbackFrom,
      fallbackRoutes: fallbacks.map(({ provider, model }) => ({ provider, model }))
    })
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
  /** 调用链路关联 id；省略时自行生成，保证同一次执行的多跳仍能聚合。 */
  traceId?: string;
};

export async function runResolvedProviderCandidates(
  tool: CliToolType,
  candidates: ResolvedRun[],
  options: RunResolvedProviderCandidatesOptions = {}
): Promise<number> {
  const confirm = options.confirm ?? promptConfirm;
  const traceId = options.traceId ?? newTraceId();
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
        model: candidate.model,
        traceId,
        attempt: index + 1
      });
    }

    console.log(`Using ${tool}: ${candidate.provider.name} / ${candidate.model}`);
    await writeLog({
      category: "usage",
      action: "tool_start",
      message: `Starting ${tool}: ${candidate.provider.name} / ${candidate.model}`,
      traceId,
      metadata: { tool, provider: candidate.provider.name, level: candidate.provider.level, model: candidate.model, mode: candidate.provider.mode, attempt: index + 1 }
    });
    if (candidate.provider.mode === "ask") {
      const confirmed = await confirm("Start CLI?");
      if (!confirmed) return 0;
    }

    const code = await runner(candidate, fallbackFrom);
    if (code === 0) {
      await recordProviderRuntimeSuccess(candidate.provider.name);
      await writeLog({
        category: "strategy",
        action: "tool_run_settled",
        message: `${tool} run served by ${candidate.provider.name}.`,
        traceId,
        metadata: {
          tool,
          provider: candidate.provider.name,
          level: candidate.provider.level,
          model: candidate.model,
          attempt: index + 1,
          fellBack: index > 0 || Boolean(candidate.fallbackFrom)
        }
      });
      return 0;
    }

    lastExitCode = code;
    await recordProviderRuntimeFailure(candidate.provider.name, `exit_code_${code}`);
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
        error: `exit_code_${code}`,
        traceId,
        attempt: index + 1
      });
      console.log(`Provider ${candidate.provider.name} failed with exit code ${code}, trying ${next.provider.name}.`);
    } else {
      await writeLog({
        level: "error",
        category: "strategy",
        action: "tool_candidates_exhausted",
        message: `All ${candidates.length} provider candidate(s) failed for ${tool}.`,
        traceId,
        metadata: {
          tool,
          totalCandidates: candidates.length,
          attempted: candidates.map((item) => item.provider.name),
          exitCode: code
        }
      });
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
  traceId?: string;
  attempt?: number;
}): Promise<void> {
  await writeLog({
    level: input.level,
    category: "strategy",
    action: input.action,
    message: `Provider fallback ${input.from} -> ${input.to} for ${input.tool}.`,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    metadata: {
      from: input.from,
      to: input.to,
      engine: input.tool,
      model: input.model,
      nextModel: input.nextModel ?? null,
      error: input.error ?? null,
      attempt: input.attempt ?? null
    }
  });
}
