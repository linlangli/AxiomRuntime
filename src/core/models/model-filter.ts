import type { CliToolType } from "../types.js";

export function isImageModel(model: string): boolean {
  const value = model.toLowerCase();
  return value.includes("image") || value.includes("dall-e");
}

export function isModelCompatible(tool: CliToolType, model: string): boolean {
  const value = model.toLowerCase();
  if (isImageModel(value)) {
    return false;
  }
  if (tool === "claude") {
    return value.includes("claude");
  }
  return value.includes("gpt") || value.includes("codex") || value.includes("grok") || /^o\d/.test(value) || value.includes("openai");
}

// 纯图片 Provider 没有任何 Claude/Codex 兼容模型，留在自动降级链上只会在轮转到它时
// 返回 403/404 并污染健康分，因此新增时直接归入 level 0（仅显式使用）。
export function isImageOnlyModelSet(defaultModel: string, models: string[]): boolean {
  const catalog = models.length ? models : defaultModel ? [defaultModel] : [];
  if (!catalog.length) return false;
  if (!catalog.some((model) => isImageModel(model))) return false;
  return !catalog.some((model) => isModelCompatible("claude", model) || isModelCompatible("codex", model));
}

export function pickCompatibleModel(tool: CliToolType, preferredModel: string, models: string[]): string | null {
  if (preferredModel && isModelCompatible(tool, preferredModel)) {
    return preferredModel;
  }
  return models.find((model) => isModelCompatible(tool, model)) ?? null;
}
