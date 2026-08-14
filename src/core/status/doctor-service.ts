import fs from "node:fs/promises";
import path from "node:path";
import {
  getCachePath,
  getConfigRoot,
  getProvidersPath,
  getSessionsPath,
  getUsagePath
} from "../config/paths.js";
import { readCache } from "../config/cache-store.js";
import { writeJsonFile } from "../config/json-store.js";
import { appendUsageEvent } from "../config/usage-store.js";
import { readProviders } from "../config/providers-store.js";
import { checkProvider, runDeepCheck } from "../models/model-discovery.js";
import { writeLog } from "../logs/log-service.js";
import { getKnownCandidates, resolveToolCommand } from "../runner/command-resolver.js";
import { isPrivilegedProcess, type ProcessIdentityOptions } from "../runner/claude-permission-policy.js";
import { resolveProviderCandidatesForTool, type ResolvedRun } from "../runner/fallback.js";
import { buildUsageEvent } from "../usage/usage-service.js";
import type { CliToolType, RunToolType } from "../types.js";

const MIN_NODE_VERSION = "22.19.0";

export type DoctorItem = {
  group: string;
  status: "ok" | "warn" | "error";
  message: string;
  suggestion?: string;
  fixed?: boolean;
};

export type DoctorOptions = {
  fix?: boolean;
  checkProviders?: boolean;
  checkNativeDependencies?: boolean;
};

type JsonFileSpec = {
  group: string;
  filePath: string;
  defaultValue: unknown;
  validate(value: unknown): boolean;
  repairInvalid: boolean;
};

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const fix = options.fix ?? false;
  const checkProviders = options.checkProviders ?? true;

  checkNodeVersion(items);
  checkExecutionUser(items);
  if (options.checkNativeDependencies ?? true) {
    await checkNativeDependencies(items);
  }
  await checkConfigRoot(items, fix);
  await checkRuntimeFiles(items, fix);
  await checkProvidersAndModels(items, checkProviders);
  checkCommand("Local CLIs", "claude", items);
  checkCommand("Local CLIs", "codex", items);
  return items;
}

function checkExecutionUser(items: DoctorItem[]): void {
  const item = getExecutionUserDoctorItem();
  if (item) items.push(item);
}

export function getExecutionUserDoctorItem(identity: ProcessIdentityOptions = {}): DoctorItem | null {
  if (!isPrivilegedProcess(identity)) return null;
  return {
    group: "Execution User",
    status: "warn",
    message: "Axiom Runtime is running as root; Claude auto/bypass permission mode is unavailable and will be constrained to default permissions.",
    suggestion: "Install globally as root if required, but run `ai` and long-lived services with a dedicated non-root account."
  };
}

export async function runDeepDoctor(tool: CliToolType = "codex", options: DoctorOptions = {}): Promise<DoctorItem[]> {
  const items = await runDoctor(options);
  try {
    const candidates = await resolveProviderCandidatesForTool(tool);
    const success = await runDeepCandidates(tool, candidates, items);
    if (!success) {
      items.push({
        group: "Deep",
        status: "error",
        message: "No provider passed deep diagnostics.",
        suggestion: "Check the provider URL, API key, model, quota, and upstream service status."
      });
    }
  } catch (error) {
    items.push({
      group: "Deep",
      status: "warn",
      message: `No usable provider for the ${tool} deep check: ${formatError(error)}`,
      suggestion: "Run `ai setup` to configure a provider, then retry the deep check."
    });
  }
  return items;
}

function checkNodeVersion(items: DoctorItem[]): void {
  const current = process.versions.node;
  if (compareVersions(current, MIN_NODE_VERSION) >= 0) {
    items.push({ group: "Installation", status: "ok", message: `Node.js ${current} (required: >=${MIN_NODE_VERSION}).` });
    return;
  }
  items.push({
    group: "Installation",
    status: "error",
    message: `Node.js ${current} is too old (required: >=${MIN_NODE_VERSION}).`,
    suggestion: "Upgrade Node.js, then reinstall `@offerpilot/axiomruntime`."
  });
}

async function checkNativeDependencies(items: DoctorItem[]): Promise<void> {
  try {
    await import("better-sqlite3");
    items.push({ group: "Installation", status: "ok", message: "Native SQLite dependency loaded successfully." });
  } catch (error) {
    items.push({
      group: "Installation",
      status: "error",
      message: `Native SQLite dependency failed to load: ${formatError(error)}`,
      suggestion: "Reinstall with `npm install --global @offerpilot/axiomruntime`, then run `ai doctor` again."
    });
  }
}

async function checkConfigRoot(items: DoctorItem[], fix: boolean): Promise<void> {
  const configRoot = getConfigRoot();
  try {
    await fs.access(configRoot, fs.constants.R_OK | fs.constants.W_OK);
    items.push({ group: "Runtime Home", status: "ok", message: `${configRoot} is readable and writable.` });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fix) {
      try {
        await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
        items.push({ group: "Runtime Home", status: "ok", message: `Created ${configRoot}.`, fixed: true });
        return;
      } catch (repairError) {
        items.push({
          group: "Runtime Home",
          status: "error",
          message: `Could not create ${configRoot}: ${formatError(repairError)}`,
          suggestion: "Set `AI_GATEWAY_HOME` to a writable directory and retry."
        });
        return;
      }
    }

    items.push({
      group: "Runtime Home",
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "warn" : "error",
      message: `${configRoot} is not ready: ${formatError(error)}`,
      suggestion: fix
        ? "Set `AI_GATEWAY_HOME` to a writable directory and retry."
        : "Run `ai doctor --fix` or `ai setup` to create it."
    });
  }
}

async function checkRuntimeFiles(items: DoctorItem[], fix: boolean): Promise<void> {
  const specs: JsonFileSpec[] = [
    {
      group: "Providers",
      filePath: getProvidersPath(),
      defaultValue: [],
      validate: Array.isArray,
      repairInvalid: false
    },
    {
      group: "Cache",
      filePath: getCachePath(),
      defaultValue: { providers: {} },
      validate: (value) => isRecord(value) && isRecord(value.providers),
      repairInvalid: true
    },
    {
      group: "Usage",
      filePath: getUsagePath(),
      defaultValue: { events: [] },
      validate: (value) => isRecord(value) && Array.isArray(value.events),
      repairInvalid: true
    },
    {
      group: "Sessions",
      filePath: getSessionsPath(),
      defaultValue: { sessions: [] },
      validate: (value) => isRecord(value) && Array.isArray(value.sessions),
      repairInvalid: true
    }
  ];

  for (const spec of specs) {
    await checkJsonFile(spec, items, fix);
  }
}

async function checkJsonFile(spec: JsonFileSpec, items: DoctorItem[], fix: boolean): Promise<void> {
  try {
    await fs.access(spec.filePath, fs.constants.R_OK | fs.constants.W_OK);
    const raw = await fs.readFile(spec.filePath, "utf8");
    const value = JSON.parse(raw) as unknown;
    if (!spec.validate(value)) {
      throw new Error("unexpected JSON structure");
    }
    items.push({ group: spec.group, status: "ok", message: `${spec.filePath} is valid.` });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (fix) {
        try {
          await writeJsonFile(spec.filePath, spec.defaultValue);
          items.push({ group: spec.group, status: "ok", message: `Created ${spec.filePath}.`, fixed: true });
        } catch (repairError) {
          items.push({
            group: spec.group,
            status: "error",
            message: `Could not create ${spec.filePath}: ${formatError(repairError)}`,
            suggestion: "Check the Runtime home directory permissions."
          });
        }
      } else {
        items.push({
          group: spec.group,
          status: "warn",
          message: `${spec.filePath} does not exist yet.`,
          suggestion: "Run `ai doctor --fix` or `ai setup` to create it."
        });
      }
      return;
    }

    if (fix && spec.repairInvalid && isRepairableJsonError(error)) {
      try {
        const backupPath = await backupInvalidFile(spec.filePath);
        await writeJsonFile(spec.filePath, spec.defaultValue);
        items.push({
          group: spec.group,
          status: "ok",
          message: `Rebuilt ${spec.filePath}; invalid data was backed up to ${backupPath}.`,
          fixed: true
        });
        return;
      } catch (repairError) {
        items.push({
          group: spec.group,
          status: "error",
          message: `Could not repair ${spec.filePath}: ${formatError(repairError)}`,
          suggestion: "Check file permissions and restore the latest valid backup."
        });
        return;
      }
    }

    items.push({
      group: spec.group,
      status: "error",
      message: `${spec.filePath} is invalid: ${formatError(error)}`,
      suggestion: spec.repairInvalid
        ? "Run `ai doctor --fix` to back up and rebuild this derived file."
        : "Provider configuration is never overwritten automatically. Correct or restore providers.json, then retry."
    });
  }
}

async function checkProvidersAndModels(items: DoctorItem[], checkConnectivity: boolean): Promise<void> {
  let providers;
  try {
    providers = await readProviders();
  } catch (error) {
    items.push({
      group: "Providers",
      status: "error",
      message: `Provider configuration could not be loaded: ${formatError(error)}`,
      suggestion: "Correct or restore providers.json; `ai doctor` will not overwrite provider credentials."
    });
    return;
  }

  if (!providers.length) {
    items.push({
      group: "Providers",
      status: "warn",
      message: "No providers are configured.",
      suggestion: "Run `ai setup` or `ai provider add` to configure the first provider."
    });
    return;
  }

  items.push({ group: "Providers", status: "ok", message: `${providers.length} provider(s) configured.` });

  let cache: Awaited<ReturnType<typeof readCache>> | null = null;
  try {
    cache = await readCache();
  } catch (error) {
    items.push({
      group: "Cache",
      status: "error",
      message: `Provider cache could not be loaded: ${formatError(error)}`,
      suggestion: "Run `ai doctor --fix` to back up and rebuild the cache."
    });
  }

  for (const provider of providers) {
    const cached = cache?.providers[provider.name];
    if (provider.model && cached?.models?.length && !cached.models.includes(provider.model)) {
      items.push({
        group: "Models",
        status: "warn",
        message: `${provider.name} default model is not in the last discovered model list: ${provider.model}`,
        suggestion: `Run \`ai status\` to refresh models, then edit ${provider.name} if necessary.`
      });
    }

    if (!checkConnectivity) continue;
    const result = await checkProvider(provider);
    const healthy = result.status === "ok" && result.models.length > 0;
    items.push({
      group: "Providers",
      status: healthy ? "ok" : "error",
      message: healthy
        ? `${provider.name}: reachable; discovered ${result.models.length} model(s).`
        : `${provider.name}: ${result.error ?? "provider returned no models"}`,
      suggestion: healthy ? undefined : diagnoseProviderError(provider.name, result.error)
    });
  }
}

async function runDeepCandidates(tool: CliToolType, candidates: ResolvedRun[], items: DoctorItem[]): Promise<boolean> {
  for (const candidate of candidates) {
    const result = await runDeepCheck(candidate.provider, candidate.model);
    if (result.status === "ok") {
      if (result.usage) {
        await recordDeepUsage(tool, candidate, result.usage);
      }
      items.push({
        group: "Deep",
        status: "ok",
        message: `${candidate.provider.name}/${candidate.model}: ok${formatUsage(result)}`
      });
      return true;
    }

    items.push({
      group: "Deep",
      status: "warn",
      message: `${candidate.provider.name}/${candidate.model}: failed, trying next provider (${result.error})`,
      suggestion: diagnoseProviderError(candidate.provider.name, result.error)
    });
    await writeLog({
      level: "warn",
      category: "strategy",
      action: "deep_fallback",
      message: `${candidate.provider.name}/${candidate.model} failed deep check; trying next provider.`,
      metadata: { provider: candidate.provider.name, model: candidate.model, tool, error: result.error }
    });
  }
  return false;
}

async function recordDeepUsage(tool: CliToolType, candidate: ResolvedRun, usage: NonNullable<Awaited<ReturnType<typeof runDeepCheck>>["usage"]>): Promise<void> {
  await appendUsageEvent(buildUsageEvent({
    provider: candidate.provider.name,
    tool,
    model: candidate.model,
    source: "doctor_deep",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  }));
  await writeLog({
    category: "usage",
    action: "token_usage_recorded",
    message: `Recorded ${usage.totalTokens} token(s) from doctor deep check.`,
    metadata: {
      provider: candidate.provider.name,
      tool,
      model: candidate.model,
      source: "doctor_deep",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens
    }
  });
}

function checkCommand(group: string, command: RunToolType, items: DoctorItem[]): void {
  const resolved = resolveToolCommand(command);
  if (resolved) {
    items.push({ group, status: "ok", message: `${command}: ${resolved}` });
    return;
  }

  const packageName = command === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
  items.push({
    group,
    status: "warn",
    message: `${command} is not installed or failed its version check. Checked: ${getKnownCandidates(command).join(", ")}`,
    suggestion: `Run \`ai setup\` or install it with \`npm install --global ${packageName}\`.`
  });
}

function diagnoseProviderError(providerName: string, error: string | null): string {
  const message = (error ?? "").toLowerCase();
  if (/401|403|unauthor|forbidden|api.?key|credential/.test(message)) {
    return `Check the API key for ${providerName} with \`ai provider edit ${providerName}\`.`;
  }
  if (/404|not found|base url|non-json/.test(message)) {
    return `Check the Base URL for ${providerName}; it may need or may already include /v1.`;
  }
  if (/429|quota|rate.?limit|credit|billing/.test(message)) {
    return `Check quota, billing, and rate limits for ${providerName}.`;
  }
  if (/timeout|abort|network|fetch|enotfound|econn/.test(message)) {
    return `Check network access, proxy settings, DNS, and the Base URL for ${providerName}.`;
  }
  return `Run \`ai provider edit ${providerName}\` to verify its URL, API key, and default model.`;
}

function formatUsage(result: Awaited<ReturnType<typeof runDeepCheck>>): string {
  if (!result.usage) return " (usage not returned)";
  return ` (${result.usage.totalTokens} tokens: ${result.usage.inputTokens} input, ${result.usage.outputTokens} output)`;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRepairableJsonError(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && error.message === "unexpected JSON structure");
}

async function backupInvalidFile(filePath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.invalid-${stamp}`);
  await fs.rename(filePath, backupPath);
  return backupPath;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
