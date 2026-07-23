import { checkAndRecordMemoryEmbeddingConfig } from "../../core/memory/embedding-check.js";
import {
  clearMemoryEmbeddingConfig,
  getMemoryEmbeddingConfig,
  setMemoryEmbeddingConfig
} from "../../core/memory/memory-config.js";
import type { MemoryEmbeddingConfig, MemoryEmbeddingProviderType } from "../../core/types.js";
import { writeLog } from "../../core/logs/log-service.js";
import { maskSecret } from "../output/table.js";
import { promptConfirm, promptSelect, promptText } from "../prompts/prompt.js";

type MemoryEmbeddingSetOptions = {
  providerType?: MemoryEmbeddingProviderType;
  queryTask?: string;
  passageTask?: string;
  dimensions?: number | null;
  skipTest: boolean;
};

export async function runMemoryCommand(args: string[]): Promise<void> {
  const [area, action, ...rest] = args;
  if (area === undefined || area === "embedding" || area === "vector") {
    await runMemoryEmbeddingCommand(area === undefined ? args : [action, ...rest].filter((item): item is string => Boolean(item)));
    return;
  }
  throw new Error(`Unknown memory command: ${area}`);
}

async function runMemoryEmbeddingCommand(args: string[]): Promise<void> {
  if (!args.length) {
    await runMemoryEmbeddingInteractive();
    return;
  }

  const [action = "show", ...rest] = args;
  if (action === "show" || action === "status") {
    await showMemoryEmbeddingConfig();
    return;
  }
  if (action === "set" || action === "edit") {
    await setEmbeddingConfig(rest);
    return;
  }
  if (action === "test" || action === "check") {
    await testEmbeddingConfig(rest.join(" ").trim() || undefined);
    return;
  }
  if (action === "clear" || action === "delete" || action === "remove") {
    await clearEmbeddingConfig();
    return;
  }
  throw new Error(`Unknown memory embedding command: ${action}`);
}

async function runMemoryEmbeddingInteractive(): Promise<void> {
  const config = await getMemoryEmbeddingConfig();
  const action = await promptSelect<"show" | "set" | "test" | "clear" | "exit">("Memory embedding", [
    { label: config ? `show current config (${config.name} / ${config.model})` : "show current config", value: "show" },
    { label: config ? "edit embedding model" : "set embedding model", value: "set" },
    ...(config ? [
      { label: "test embedding model", value: "test" as const },
      { label: "clear embedding model", value: "clear" as const }
    ] : []),
    { label: "exit", value: "exit" }
  ]);

  if (action === "exit") return;
  if (action === "show") {
    await showMemoryEmbeddingConfig();
    return;
  }
  if (action === "set") {
    await setEmbeddingConfig([]);
    return;
  }
  if (action === "test") {
    await testEmbeddingConfig();
    return;
  }
  if (action === "clear") {
    await clearEmbeddingConfig();
  }
}

async function showMemoryEmbeddingConfig(): Promise<void> {
  const config = await getMemoryEmbeddingConfig();
  if (!config) {
    console.log("No memory embedding model configured.");
    console.log("Run `ai memory embedding set` to configure one.");
    return;
  }
  printEmbeddingConfig(config);
}

async function setEmbeddingConfig(args: string[]): Promise<void> {
  const options = parseSetOptions(args);
  const positional = parseSetPositionals(args);
  const existing = await getMemoryEmbeddingConfig();
  const interactive = positional.length < 4;

  const name = positional[0] ?? await promptText("Embedding provider name", { defaultValue: existing?.name ?? "jina" });
  const baseUrl = positional[1] ?? await promptText("Embedding base URL", { defaultValue: existing?.baseUrl ?? "https://api.jina.ai/v1" });
  const apiKey = positional[2] ?? await promptApiKey(existing?.apiKey);
  const model = positional[3] ?? await promptText("Embedding model", { defaultValue: existing?.model ?? "jina-embeddings-v3" });
  const providerType = options.providerType ?? (interactive
    ? await promptSelect<MemoryEmbeddingProviderType>("Embedding API type", [
      { label: "jina", value: "jina" },
      { label: "openai-compatible", value: "openai-compatible" }
    ])
    : undefined);

  const queryTask = options.queryTask ?? (interactive && providerType === "jina"
    ? await promptText("Query task", { defaultValue: existing?.queryTask ?? "retrieval.query" })
    : undefined);
  const passageTask = options.passageTask ?? (interactive && providerType === "jina"
    ? await promptText("Passage task", { defaultValue: existing?.passageTask ?? "retrieval.passage" })
    : undefined);
  const dimensions = options.dimensions ?? null;

  const config = await setMemoryEmbeddingConfig({
    name,
    baseUrl,
    apiKey,
    model,
    providerType,
    queryTask,
    passageTask,
    dimensions
  });

  console.log(`Configured memory embedding model: ${config.name} / ${config.model}`);
  if (!options.skipTest) {
    const result = await checkAndRecordMemoryEmbeddingConfig(config);
    if (result.status === "ok") {
      console.log(`Embedding check: ok (${result.dimensions} dimensions)`);
    } else {
      console.log(`Embedding check: error (${result.error})`);
    }
  }
  await writeLog({
    category: "system",
    action: "memory_embedding_config_set",
    message: `Configured memory embedding model: ${config.name} / ${config.model}`,
    metadata: { name: config.name, baseUrl: config.baseUrl, model: config.model, providerType: config.providerType }
  });
}

async function testEmbeddingConfig(text = "ping"): Promise<void> {
  const config = await getMemoryEmbeddingConfig();
  if (!config) {
    console.log("No memory embedding model configured.");
    console.log("Run `ai memory embedding set` first.");
    return;
  }
  const result = await checkAndRecordMemoryEmbeddingConfig(config, text);
  if (result.status === "ok") {
    console.log(`Memory embedding check: ok`);
    console.log(`Model: ${result.model}`);
    console.log(`Dimensions: ${result.dimensions}`);
    return;
  }
  console.log("Memory embedding check: error");
  console.log(result.error);
}

async function clearEmbeddingConfig(): Promise<void> {
  const config = await getMemoryEmbeddingConfig();
  if (!config) {
    console.log("No memory embedding model configured.");
    return;
  }
  const confirmed = await promptConfirm(`Clear memory embedding model ${config.name} / ${config.model}?`, false);
  if (!confirmed) {
    console.log("Clear cancelled.");
    return;
  }
  await clearMemoryEmbeddingConfig();
  console.log("Cleared memory embedding model config.");
  await writeLog({
    category: "system",
    action: "memory_embedding_config_clear",
    message: `Cleared memory embedding model config: ${config.name} / ${config.model}`,
    metadata: { name: config.name, model: config.model }
  });
}

function printEmbeddingConfig(config: MemoryEmbeddingConfig): void {
  console.log("Memory Embedding Model");
  console.log("=".repeat(72));
  console.log(`  Name       ${config.name}`);
  console.log(`  Base URL   ${config.baseUrl}`);
  console.log(`  API Key    ${maskSecret(config.apiKey)}`);
  console.log(`  Type       ${config.providerType}`);
  console.log(`  Model      ${config.model}`);
  console.log(`  Query      ${config.queryTask ?? "(default)"}`);
  console.log(`  Passage    ${config.passageTask ?? "(default)"}`);
  console.log(`  Dims       ${config.dimensions ?? "(unknown)"}`);
  console.log(`  Checked    ${config.lastCheckedAt ?? "(never)"}`);
  if (config.lastError) console.log(`  Error      ${config.lastError}`);
}

function parseSetOptions(args: string[]): MemoryEmbeddingSetOptions {
  const options: MemoryEmbeddingSetOptions = { skipTest: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--skip-test") {
      options.skipTest = true;
      continue;
    }
    if (arg === "--type" || arg === "--provider-type") {
      options.providerType = parseProviderType(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--query-task") {
      options.queryTask = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--passage-task") {
      options.passageTask = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--dimensions") {
      const dimensions = Number(readOptionValue(args, index, arg));
      if (!Number.isInteger(dimensions) || dimensions <= 0) {
        throw new Error("--dimensions must be a positive integer.");
      }
      options.dimensions = dimensions;
      index += 1;
    }
  }
  return options;
}

function parseSetPositionals(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--skip-test") continue;
    if (arg.startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

async function promptApiKey(existing: string | undefined): Promise<string> {
  const message = existing ? "Embedding API key (leave blank to keep current)" : "Embedding API key";
  const value = await promptText(message);
  return value || existing || "";
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseProviderType(value: string): MemoryEmbeddingProviderType {
  if (value === "jina" || value === "openai-compatible") return value;
  throw new Error("--type must be jina or openai-compatible.");
}
