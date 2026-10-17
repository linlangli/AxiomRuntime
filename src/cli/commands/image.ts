import { planImageGeneration, ImagePlanClarificationError, normalizeImageSize } from "../../core/images/image-generation-plan.js";
import { readCache } from "../../core/config/cache-store.js";
import { generateImages, MAX_REFERENCE_IMAGES } from "../../core/images/image-generation-service.js";
import { listProviders, refreshAllProviders } from "../../core/providers/provider-service.js";
import type { CacheFile, Provider } from "../../core/types.js";
import { promptSelect, promptText } from "../prompts/prompt.js";

export type ImageCommandInput = {
  provider?: string;
  model?: string;
  target?: string;
  prompt: string;
  count?: number;
  size?: string;
  imagePath?: string;
  imagePaths?: string[];
};

export async function runImageCommand(args: string[]): Promise<void> {
  await refreshAllProviders();
  const [providers, cache] = await Promise.all([listProviders(), readCache()]);
  const input = await resolveImageCommandInput(args, providers, cache.providers);
  if (input.imagePath || input.imagePaths?.length) console.log("Reference images will be uploaded to one selected provider. Automatic retries and cross-provider fallback are disabled.");
  const plan = planImageGeneration(input);
  console.log(`Generating ${plan.length} image(s): ${plan.map((task) => task.size ?? "provider default size").join(", ")}`);
  const result = await generateImages(input);
  for (const task of result.tasks) {
    for (const image of task.images) {
      console.log(`Image ${task.index}${image.actualSize ? ` (${image.actualSize})` : ""}: ${image.provider} / ${image.model}`);
      if (image.filePath) console.log(`Image saved: ${image.filePath}`);
      if (image.url) console.log(`Image URL: ${image.url}`);
      if (image.warning) console.warn(image.warning);
      if (image.revisedPrompt) console.log(`Revised prompt: ${image.revisedPrompt}`);
    }
    if (task.error) console.error(`Image ${task.index} failed: ${task.error}`);
  }
  console.log(`Saved/returned ${result.images.length} image(s); ${result.tasks.filter((task) => task.error).length} task(s) failed.`);
  if (!result.success) process.exitCode = 1;
}

export async function resolveImageCommandInput(
  args: string[],
  providers: Provider[],
  providerCache: CacheFile["providers"],
  select: typeof promptSelect = promptSelect,
  text: typeof promptText = promptText
): Promise<ImageCommandInput> {
  if (!providers.length) {
    throw new Error("No providers configured. Run `ai add` first.");
  }

  const parsed = parseImageArgs(args);
  args = parsed.args;
  const imagePaths = parsed.imagePaths;
  const target = args[0]?.trim();
  const resolvePrompt = async (promptArgs: string[]): Promise<Pick<ImageCommandInput, "prompt" | "count" | "size" | "imagePath" | "imagePaths">> => {
    if (!promptArgs.length && !imagePaths.length) {
      const mode = await select("Select image mode", [
        { label: "Text to image / 文生图", value: "generate" },
        { label: "Reference local image / 参考本地图片", value: "edit" }
      ]);
      if (mode === "edit") {
        while (true) {
          const imagePath = (await text(imagePaths.length
            ? "Next reference image path (leave empty to finish)"
            : "Local reference image path (PNG, JPEG, WebP; max 20 MiB)"))
            .trim().replace(/^(["'])(.*)\1$/, "$2");
          if (!imagePath) {
            if (!imagePaths.length) throw new Error("Local reference image path is required.");
            break;
          }
          imagePaths.push(imagePath);
          if (imagePaths.length === MAX_REFERENCE_IMAGES) break;
        }
      }
    }
    let originalPrompt = requirePrompt(promptArgs.join(" ").trim() || await text("Image prompt"));
    let prompt = originalPrompt;
    let count = parsed.count;
    while (true) {
      try { planImageGeneration({ prompt, count, size: parsed.size }); break; }
      catch (error) {
        if (!(error instanceof ImagePlanClarificationError) || promptArgs.length) throw error;
        if (error.field === "sizes") {
          const sizes = requirePrompt(await text(`${error.message} Output sizes (keep the original Image prompt)`));
          if (!/\d+\s*[x×*]\s*\d+/i.test(sizes)) continue;
          prompt = `${originalPrompt}\nOutput sizes: ${sizes}`;
        } else if (error.field === "count") {
          const answer = requirePrompt(await text(`${error.message} Enter a count (1–8), or a revised full Image prompt`));
          const numeric = /^([1-8])\s*(?:张(?:图片)?|幅)?$/.exec(answer);
          if (numeric) { count = Number(numeric[1]); prompt = originalPrompt; }
          else if (/^\d+\s*(?:张(?:图片)?|幅)?$/.test(answer)) continue;
          else { originalPrompt = answer; prompt = answer; }
        } else {
          const answer = requirePrompt(await text(`${error.message} Please restate the full Image prompt`));
          if (/^\d+$/.test(answer)) continue;
          originalPrompt = answer;
          prompt = answer;
        }
      }
    }
    return { prompt, ...(count !== undefined ? { count } : {}), ...(parsed.size ? { size: parsed.size } : {}),
      ...(imagePaths.length === 1 ? { imagePath: imagePaths[0]! } : imagePaths.length ? { imagePaths } : {}) };
  };
  const namedProvider = target ? providers.find((provider) => provider.name === target) : undefined;
  if (target && !namedProvider) {
    return { target, ...await resolvePrompt(args.slice(1)) };
  }

  const provider = namedProvider ?? await selectImageProvider(providers, providerCache, select);
  const models = getProviderImageModels(provider, providerCache);
  const secondArg = args[1]?.trim();
  const hasExplicitModel = Boolean(secondArg && models.includes(secondArg));
  const model = hasExplicitModel
    ? secondArg!
    : target
      ? getDefaultImageModel(provider, models)
      : await selectImageModel(provider, models, select);
  const promptArgs = hasExplicitModel ? args.slice(2) : args.slice(1);
  return { provider: provider.name, model, ...await resolvePrompt(promptArgs) };
}

function parseImageArgs(input: string[]): { args: string[]; imagePaths: string[]; count?: number; size?: string } {
  let count: number | undefined;
  let size: string | undefined;
  const args: string[] = [];
  const imagePaths: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]!;
    if (argument === "--") { args.push(...input.slice(index + 1)); break; }
    if (argument === "--count" || argument.startsWith("--count=")) {
      if (count !== undefined) throw new Error("--count may only be supplied once.");
      const value = argument === "--count" ? input[++index] : argument.slice("--count=".length);
      if (!value || !/^[1-8]$/.test(value)) throw new Error("--count requires an integer from 1 to 8.");
      count = Number(value);
    } else if (argument === "--size" || argument.startsWith("--size=")) {
      if (size !== undefined) throw new Error("--size may only be supplied once.");
      const value = argument === "--size" ? input[++index] : argument.slice("--size=".length);
      if (!value || value.startsWith("--")) throw new Error("--size requires WIDTHxHEIGHT or auto.");
      size = normalizeImageSize(value);
    } else if (argument === "--image" || argument.startsWith("--image=")) {
      if (imagePaths.length >= MAX_REFERENCE_IMAGES) throw new Error("At most 8 reference images are supported.");
      const value = argument === "--image" ? input[++index] : argument.slice("--image=".length);
      if (!value?.trim() || value.startsWith("--")) throw new Error("--image requires a local file path.");
      imagePaths.push(value.trim());
    } else {
      if (argument.startsWith("--")) throw new Error(`Unknown image option: ${argument.split("=")[0]}`);
      args.push(argument);
    }
  }
  return { args, imagePaths, count, size };
}

async function selectImageProvider(
  providers: Provider[],
  providerCache: CacheFile["providers"],
  select: typeof promptSelect
): Promise<Provider> {
  const availableProviders = providers.filter((provider) => getProviderImageModels(provider, providerCache).length);
  if (!availableProviders.length) {
    throw new Error("No configured provider has available image models. Run `ai status` to refresh model lists.");
  }
  const providerName = await select(
    "Select image provider",
    availableProviders.map((provider) => ({
      label: `${provider.name} / ${getProviderImageModels(provider, providerCache).length} models`,
      value: provider.name
    }))
  );
  return availableProviders.find((provider) => provider.name === providerName)!;
}

async function selectImageModel(
  provider: Provider,
  models: string[],
  select: typeof promptSelect
): Promise<string> {
  if (!models.length) {
    throw new Error(`Provider ${provider.name} has no available image models. Run \`ai status\` first.`);
  }
  return select(
    `Select image model for ${provider.name}`,
    models.map((model) => ({ label: model, value: model }))
  );
}

function getProviderImageModels(provider: Provider, providerCache: CacheFile["providers"]): string[] {
  const cachedModels = providerCache[provider.name]?.models ?? [];
  const models = cachedModels.length ? [...new Set(cachedModels)] : provider.model ? [provider.model] : [];
  return provider.model && models.includes(provider.model)
    ? [provider.model, ...models.filter((model) => model !== provider.model)]
    : models;
}

function getDefaultImageModel(provider: Provider, models: string[]): string {
  if (provider.model && models.includes(provider.model)) return provider.model;
  throw new Error(`Provider ${provider.name} has no usable default image model. Specify one of: ${models.join(", ") || "(none)"}.`);
}

function requirePrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt) throw new Error("Image prompt is required.");
  return prompt;
}
