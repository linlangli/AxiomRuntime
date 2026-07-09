import type { Provider } from "../types.js";
import { getToolBaseUrl } from "../runner/tool-runner.js";
import type { HermesRobot } from "./hermes-types.js";

export function buildLocalHermesConfig(
  existing: string,
  robot: HermesRobot,
  provider: Provider,
  providers: Provider[],
  providerModels: Record<string, string[]>
): string {
  const modelBlock = [
    "model:",
    `  default: ${yamlString(robot.model)}`,
    `  provider: ${yamlString(provider.name)}`,
    `  base_url: ${yamlString(getHermesProviderBaseUrl(robot, provider))}`,
    `  api_key: ${yamlString(provider.apiKey)}`
  ];
  const withModel = replaceTopLevelYamlBlock(existing, "model", modelBlock);
  const withProviders = replaceTopLevelYamlBlock(withModel, "providers", buildHermesProvidersBlock(providers, providerModels));
  return replaceTopLevelYamlBlock(withProviders, "custom_providers", buildHermesCustomProvidersBlock(providers, providerModels));
}

export function buildLocalHermesEnv(existing: string): string {
  const updates: Record<string, string> = {
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "",
    ANTHROPIC_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    OPENROUTER_API_KEY: "",
    OPENROUTER_BASE_URL: "",
    COPILOT_GITHUB_TOKEN: "",
    GH_TOKEN: ""
  };
  return replaceEnvValues(existing, updates);
}

export function buildHermesProvidersBlock(providers: Provider[], providerModels: Record<string, string[]>): string[] {
  const lines = ["providers:"];
  if (!providers.length) return [...lines, "  {}"];
  for (const provider of providers) {
    const models = providerModels[provider.name] ?? [];
    lines.push(`  ${yamlKey(provider.name)}:`);
    lines.push(`    name: ${yamlString(provider.name)}`);
    lines.push(`    api: ${yamlString(getProviderDefaultBaseUrl(provider))}`);
    lines.push(`    api_key: ${yamlString(provider.apiKey)}`);
    lines.push(`    default_model: ${yamlString(provider.model)}`);
    lines.push(`    transport: ${yamlString(getProviderApiMode(provider))}`);
    lines.push("    ai_gateway_managed: true");
    if (models.length) {
      lines.push("    models:");
      for (const model of models) lines.push(`      - ${yamlString(model)}`);
    } else {
      lines.push("    models: []");
    }
  }
  return lines;
}

export function buildHermesCustomProvidersBlock(providers: Provider[], providerModels: Record<string, string[]>): string[] {
  const lines = ["custom_providers:"];
  if (!providers.length) return [...lines, "  []"];
  for (const provider of providers) {
    const models = providerModels[provider.name] ?? [];
    lines.push(`  - name: ${yamlString(provider.name)}`);
    lines.push(`    base_url: ${yamlString(getProviderDefaultBaseUrl(provider))}`);
    lines.push(`    api_key: ${yamlString(provider.apiKey)}`);
    lines.push(`    model: ${yamlString(provider.model)}`);
    lines.push(`    api_mode: ${yamlString(getProviderApiMode(provider))}`);
    lines.push("    ai_gateway_managed: true");
    if (models.length) {
      lines.push("    models:");
      for (const model of models) {
        lines.push(`      ${yamlKey(model)}:`);
        lines.push("        context_length: null");
      }
    } else {
      lines.push("    models: {}");
    }
  }
  return lines;
}

export function reconcileLocalHermesModelBlock(raw: string, providers: Provider[]): string {
  const modelBlock = extractYamlBlock(raw, "model");
  const activeProviderName = extractYamlValue(modelBlock, "provider");
  if (!activeProviderName) return raw;

  const provider = providers.find((item) => item.name === activeProviderName);
  if (!provider) {
    return replaceTopLevelYamlBlock(raw, "model", [
      "model:",
      "  default: \"\"",
      "  provider: \"\"",
      "  base_url: \"\"",
      "  api_key: \"\""
    ]);
  }

  const model = extractYamlValue(modelBlock, "default") || provider.model;
  return replaceTopLevelYamlBlock(raw, "model", [
    "model:",
    `  default: ${yamlString(model)}`,
    `  provider: ${yamlString(provider.name)}`,
    `  base_url: ${yamlString(getHermesProviderBaseUrl({ model } as HermesRobot, provider))}`,
    `  api_key: ${yamlString(provider.apiKey)}`
  ]);
}

export function replaceTopLevelYamlBlock(raw: string, key: string, replacement: string[]): string {
  const lines = raw ? raw.split(/\r?\n/) : [];
  const matchingBlocks = findTopLevelYamlBlocks(lines, key);
  if (!matchingBlocks.length) {
    const prefix = raw.trim() ? `${raw.replace(/\s*$/, "")}\n\n` : "";
    return `${prefix}${replacement.join("\n")}\n`;
  }

  const nextLines: string[] = [];
  let cursor = 0;
  for (const [index, block] of matchingBlocks.entries()) {
    nextLines.push(...lines.slice(cursor, block.start));
    if (index === 0) {
      nextLines.push(...replacement);
    }
    cursor = block.end;
  }
  nextLines.push(...lines.slice(cursor));
  return `${nextLines.join("\n").replace(/\s*$/, "")}\n`;
}

function findTopLevelYamlBlocks(lines: string[], key: string): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  const pattern = new RegExp(`^${escapeRegExp(key)}:(?:\\s.*)?$`);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith(" ") || !pattern.test(line.trim())) continue;

    let end = index + 1;
    while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!))) {
      end += 1;
    }
    blocks.push({ start: index, end });
    index = end - 1;
  }
  return blocks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceEnvValues(raw: string, updates: Record<string, string>): string {
  const lines = raw ? raw.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;
    const key = match[1]!;
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${quoteEnvValue(updates[key]!)}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }
  return `${nextLines.filter((line, index, array) => line || index < array.length - 1).join("\n").replace(/\s*$/, "")}\n`;
}

function quoteEnvValue(value: string): string {
  if (!value) return "";
  return JSON.stringify(value);
}

export function getHermesProviderBaseUrl(robot: Pick<HermesRobot, "model">, provider: Provider): string {
  return getToolBaseUrl(robot.model.toLowerCase().includes("claude") ? "claude" : "codex", provider);
}

export function getProviderDefaultBaseUrl(provider: Provider): string {
  return getToolBaseUrl(provider.model.toLowerCase().includes("claude") ? "claude" : "codex", provider);
}

export function getProviderApiMode(provider: Provider): string {
  return provider.model.toLowerCase().includes("claude") ? "anthropic_messages" : "chat_completions";
}

function yamlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : yamlString(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function extractYamlBlock(raw: string, key: string): string {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) return "";
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

export function extractYamlValue(block: string, key: string): string {
  const match = block.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, "m"));
  return stripYamlQuotes(match?.[1] ?? "");
}

export function extractYamlModels(block: string): string[] {
  const models = new Set<string>();
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s+models:\s*/.test(line));
  if (start < 0) return [];
  const modelIndent = lines[start]!.match(/^(\s*)/)?.[1].length ?? 0;

  for (const line of lines.slice(start + 1)) {
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (line.trim() && indent <= modelIndent) break;
    const listItem = line.match(/^\s+-\s*(.+?)\s*$/);
    if (listItem) {
      models.add(stripYamlQuotes(listItem[1]!));
      continue;
    }
    const mapKey = line.match(/^\s+(.+?):\s*$/);
    if (mapKey) {
      const value = stripYamlQuotes(mapKey[1]!);
      if (value && value !== "{}") models.add(value);
    }
  }

  return [...models];
}

export function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}
