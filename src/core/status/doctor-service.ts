import fs from "node:fs/promises";
import { getCachePath, getProvidersPath, getUsagePath } from "../config/paths.js";
import { readCache } from "../config/cache-store.js";
import { ensureUsageFile } from "../config/usage-store.js";
import { readProviders } from "../config/providers-store.js";
import { checkProvider, runDeepCheck } from "../models/model-discovery.js";
import { getKnownCandidates, resolveToolCommand } from "../runner/command-resolver.js";
import { resolveProviderForTool } from "../runner/fallback.js";
import type { ToolType } from "../types.js";

export type DoctorItem = {
  group: string;
  status: "ok" | "warn" | "error";
  message: string;
};

export async function runDoctor(): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  await checkJsonFile("Config", getProvidersPath(), items, true);
  await checkJsonFile("Cache", getCachePath(), items, false);
  await ensureUsageFile();
  await checkJsonFile("Usage", getUsagePath(), items, false);

  try {
    const providers = await readProviders();
    items.push({ group: "Providers", status: "ok", message: `${providers.length} provider(s) configured.` });

    const levels = providers.map((provider) => provider.level);
    const expected = Array.from({ length: providers.length }, (_, index) => index + 1);
    if (levels.join(",") === expected.join(",")) {
      items.push({ group: "Providers", status: "ok", message: "Provider levels are continuous." });
    } else {
      items.push({ group: "Providers", status: "error", message: "Provider levels are not continuous." });
    }

    const cache = await readCache();
    for (const provider of providers) {
      const cached = cache.providers[provider.name];
      if (provider.model && cached?.models?.length && !cached.models.includes(provider.model)) {
        items.push({
          group: "Models",
          status: "warn",
          message: `${provider.name} default model is not in cache: ${provider.model}`
        });
      }

      const result = await checkProvider(provider);
      items.push({
        group: "Providers",
        status: result.status === "ok" ? "ok" : "error",
        message: `${provider.name}: ${result.status}${result.error ? ` (${result.error})` : ""}`
      });
    }
  } catch (error) {
    items.push({ group: "Config", status: "error", message: error instanceof Error ? error.message : String(error) });
  }

  checkCommand("Local CLIs", "claude", items);
  checkCommand("Local CLIs", "codex", items);
  return items;
}

export async function runDeepDoctor(tool: ToolType = "codex"): Promise<DoctorItem[]> {
  const items = await runDoctor();
  try {
    const resolved = await resolveProviderForTool(tool);
    const result = await runDeepCheck(resolved.provider, resolved.model);
    items.push({
      group: "Deep",
      status: result.status === "ok" ? "ok" : "error",
      message: `${resolved.provider.name}/${resolved.model}: ${result.status}${result.error ? ` (${result.error})` : ""}`
    });
  } catch (error) {
    items.push({
      group: "Deep",
      status: "warn",
      message: `No usable provider for deep check. Fell back to regular doctor. ${error instanceof Error ? error.message : String(error)}`
    });
  }
  return items;
}

async function checkJsonFile(group: string, filePath: string, items: DoctorItem[], missingIsWarn: boolean): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.R_OK | fs.constants.W_OK);
    const raw = await fs.readFile(filePath, "utf8");
    JSON.parse(raw);
    items.push({ group, status: "ok", message: `${filePath} is readable, writable, and valid JSON.` });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && missingIsWarn) {
      items.push({ group, status: "warn", message: `${filePath} does not exist yet.` });
      return;
    }
    if (code === "ENOENT") {
      items.push({ group, status: "warn", message: `${filePath} was missing and may be created automatically.` });
      return;
    }
    items.push({ group, status: "error", message: `${filePath}: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function checkCommand(group: string, command: ToolType, items: DoctorItem[]): void {
  const resolved = resolveToolCommand(command);
  if (resolved) {
    items.push({ group, status: "ok", message: `${command}: ${resolved}` });
  } else {
    items.push({
      group,
      status: "warn",
      message: `${command} is not installed or not in PATH. Checked: ${getKnownCandidates(command).join(", ")}`
    });
  }
}
