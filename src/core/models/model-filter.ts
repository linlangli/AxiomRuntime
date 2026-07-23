import type { CliToolType } from "../types.js";

export function isModelCompatible(tool: CliToolType, model: string): boolean {
  const value = model.toLowerCase();
  if (tool === "claude") {
    return value.includes("claude");
  }
  return value.includes("gpt") || value.includes("codex") || value.includes("grok") || /^o\d/.test(value) || value.includes("openai");
}

export function pickCompatibleModel(tool: CliToolType, preferredModel: string, models: string[]): string | null {
  if (preferredModel && isModelCompatible(tool, preferredModel)) {
    return preferredModel;
  }
  return models.find((model) => isModelCompatible(tool, model)) ?? null;
}
