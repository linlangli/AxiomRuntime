/** Deterministic planning only: no extra model call and no prompt uploads. */
export const MAX_OUTPUT_IMAGES = 8;

export type ImagePlanInput = { prompt: string; count?: number; size?: string };
export type ImageGenerationTask = { index: number; prompt: string; size?: string };
export class ImagePlanClarificationError extends Error {
  constructor(message: string, readonly field: "count" | "sizes" | "prompt" = "prompt", readonly count?: number) { super(message); }
}

const NUMBER = "(?:[0-9]+|[一二两三四五六七八九十百千万零〇]+)";

function countOf(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    return (tens ? digits[tens] ?? 100 : 1) * 10 + (ones ? digits[ones] ?? 100 : 0);
  }
  return digits[value] ?? 100;
}

export function normalizeImageSize(value: string): string {
  if (value.trim().toLowerCase() === "auto") return "auto";
  const match = /^(\d{1,5})\s*[x×*]\s*(\d{1,5})$/i.exec(value.trim());
  if (!match) throw new Error("Image size must be WIDTHxHEIGHT in pixels, or auto (for example 1024x1536).");
  const [width, height] = [Number(match[1]), Number(match[2])];
  if (width < 64 || height < 64 || width > 8192 || height > 8192 || width * height > 16_777_216) {
    throw new Error("Image dimensions must be 64–8192 pixels, at most 16 megapixels; provider limits may be lower.");
  }
  return `${width}x${height}`;
}

/** Known model constraints only. Model catalogs do not advertise arbitrary provider size support. */
export function validateImageModelSize(model: string, size?: string): void {
  if (!size) return;
  const supported = model === "dall-e-2" ? ["256x256", "512x512", "1024x1024"]
    : model === "dall-e-3" ? ["1024x1024", "1792x1024", "1024x1792"] : null;
  if (supported && !supported.includes(size)) {
    throw new Error(`${model} does not support size ${size}. Supported sizes: ${supported.join(", ")}.`);
  }
}

/** Parse explicit output counts and pixel sizes; ambiguous briefs must be clarified before billing. */
export function planImageGeneration(input: ImagePlanInput): ImageGenerationTask[] {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Image prompt is required.");
  if (/^[0-9一二两三四五六七八九十]+\s*(?:张|幅)?$/u.test(prompt)) {
    throw new ImagePlanClarificationError("Describe the image subject and style; a number alone is not an Image prompt.");
  }
  if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_OUTPUT_IMAGES)) {
    throw new Error(`Image count must be an integer from 1 to ${MAX_OUTPUT_IMAGES}.`);
  }
  const explicitSize = input.size === undefined ? undefined : normalizeImageSize(input.size);
  // Text to render inside an image is not an instruction to the Runtime.
  const instructions = prompt.replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/gu, (quoted) => " ".repeat(quoted.length));
  const totalMatch = new RegExp(`(?:生成|制作|输出|画|绘制|做)\\s*(?:一共|总共|共)?\\s*(${NUMBER})\\s*(?:张|幅)`, "u").exec(instructions)
    ?? /\b(?:generate|create|make|produce|draw)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:different\s+)?(?:images?|pictures?|posters?|photos?|illustrations?)\b/i.exec(instructions)
    ?? new RegExp(`(?:^|[，,。；;：:\\n])\\s*(?:一共|总共|共|需要|要)?\\s*(${NUMBER})\\s*(?:张|幅)(?:图片|图像|图|壁纸|海报|照片|插画)`, "u").exec(instructions)
    ?? /(?:^|[,;:.!\n])\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:images?|pictures?|posters?|photos?|wallpapers?)\b/i.exec(instructions);
  const englishCounts: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const total = totalMatch ? englishCounts[totalMatch[1]!.toLowerCase()] ?? countOf(totalMatch[1]!) : undefined;
  const dimensions = [...instructions.matchAll(/(?<!\d)(\d+)\s*[x×*]\s*(\d+)(?!\d)/giu)];
  const entries = dimensions.map((match) => {
    const before = instructions.slice(0, match.index);
    const localCount = new RegExp(`(${NUMBER})\\s*(?:张|幅)\\s*(?:(?:尺寸|大小)(?:为|是)?\\s*)?$`, "u").exec(before)
      ?? /(\d+)\s+(?:images?|pictures?|posters?|photos?)\s+(?:at\s+|of\s+)?$/i.exec(before);
    const clauseStart = Math.max(...[",", "，", "、", ";", "；", "：", ":", "\n"].map((separator) => before.lastIndexOf(separator))) + 1;
    const after = prompt.slice(match.index + match[0].length);
    const clauseEnd = after.search(/[,，、;；。\n]/u);
    return {
      size: normalizeImageSize(`${match[1]}x${match[2]}`),
      count: localCount ? countOf(localCount[1]!) : 1,
      detail: prompt.slice(clauseStart, match.index + match[0].length + (clauseEnd < 0 ? after.length : clauseEnd))
    };
  });
  let sizes = entries.flatMap((entry) => Array.from({ length: Math.min(entry.count, MAX_OUTPUT_IMAGES + 1) }, () => ({ size: entry.size, detail: entry.detail })));
  if (entries.some((entry) => entry.count < 1 || entry.count > MAX_OUTPUT_IMAGES)) throw new Error(`At most ${MAX_OUTPUT_IMAGES} output images are supported.`);
  if (entries.length === 1 && entries[0]!.count === 1 && (total !== undefined || input.count !== undefined)) {
    sizes = Array.from({ length: Math.min(total ?? input.count!, MAX_OUTPUT_IMAGES + 1) }, () => sizes[0]!);
  }
  if (total !== undefined && sizes.length && total !== sizes.length) {
    throw new ImagePlanClarificationError("Image count conflicts with the size list. Specify each image and size explicitly.", "sizes", total);
  }
  const inferredCount = total ?? (sizes.length || undefined);
  if (input.count !== undefined && inferredCount !== undefined && input.count !== inferredCount) {
    throw new ImagePlanClarificationError("--count conflicts with the prompt. Use the same image count in both.");
  }
  if (explicitSize && sizes.some((entry) => entry.size !== explicitSize)) {
    throw new ImagePlanClarificationError("--size conflicts with the prompt. Use matching sizes or omit --size for mixed sizes.");
  }
  const vagueOutputCount = /(?:(?:生成|制作|输出|绘制|画|做|需要|想要|给我|提供)\s*|(?:^|[，,。；;：:\n])\s*)(?:多张|多幅|几张|若干张|一组|一套)|(?:multiple|several|many|a few|a couple of)\s+(?:images|pictures|posters|photos)/i.test(instructions);
  if (inferredCount === undefined && input.count === undefined && vagueOutputCount) {
    throw new ImagePlanClarificationError("How many images? Specify an exact count (1–8), for example: 生成3张图片.", "count");
  }
  const count = input.count ?? inferredCount ?? 1;
  const differentSizes = /不同尺寸|不同大小|[二两三四五六七八九2-9]\s*种尺寸|different\s+sizes/i.test(instructions);
  const screenSize = /4\s*k|手机屏幕|(?:pc|电脑)屏幕|横版|竖版|landscape|portrait/i.test(instructions);
  if ((!explicitSize && !sizes.length && (differentSizes || screenSize))
    || (differentSizes && count > 1 && new Set(sizes.map((entry) => entry.size)).size < 2)) {
    throw new ImagePlanClarificationError(`Identified ${count} image(s). Specify pixel sizes in output order, for example: 2160x3840, 3840x2160 (4K phone/PC wallpaper; provider support varies).`, "sizes", count);
  }
  if (count < 1 || count > MAX_OUTPUT_IMAGES) throw new Error(`Image count must be from 1 to ${MAX_OUTPUT_IMAGES}.`);
  return Array.from({ length: count }, (_, index) => {
    const size = explicitSize ?? sizes[index]?.size;
    return {
      index: index + 1,
      ...(size ? { size } : {}),
      prompt: count === 1 ? prompt : `${prompt}\n\nGenerate exactly ONE standalone image for item ${index + 1} of ${count}.${size ? ` Requested size: ${size}.` : ""}${sizes[index]?.detail ? ` This item's requirement: ${sizes[index]!.detail}.` : ""} Keep the shared style and subject from the brief. Do not combine the requested outputs into a collage or grid.`
    };
  });
}
