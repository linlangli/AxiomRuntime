import type { ToolType } from "../types.js";

export function isModelCompatible(tool: ToolType, model: string): boolean {
  const value = model.toLowerCase();
  if (tool === "claude") {
    return value.includes("claude");
  }
  return value.includes("gpt") || value.includes("codex") || /^o\d/.test(value) || value.includes("openai");
}

export function pickCompatibleModel(tool: ToolType, preferredModel: string, models: string[]): string | null {
  if (preferredModel && isModelCompatible(tool, preferredModel)) {
    return preferredModel;
  }
  return models.find((model) => isModelCompatible(tool, model)) ?? null;
}
