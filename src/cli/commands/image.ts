import { readCache } from "../../core/config/cache-store.js";
import { generateImage } from "../../core/images/image-generation-service.js";
import { listProviders, refreshAllProviders } from "../../core/providers/provider-service.js";
import type { CacheFile, Provider } from "../../core/types.js";
import { promptSelect, promptText } from "../prompts/prompt.js";

export type ImageCommandInput = {
  provider?: string;
  model?: string;
  target?: string;
  prompt: string;
  imagePath?: string;
};

export async function runImageCommand(args: string[]): Promise<void> {
  await refreshAllProviders();
  const [providers, cache] = await Promise.all([listProviders(), readCache()]);
  const input = await resolveImageCommandInput(args, providers, cache.providers);
  if (input.imagePath) console.log("Reference image will be uploaded to one selected provider. Automatic retries and cross-provider fallback are disabled.");
  const result = await generateImage(input);
  console.log(`Generated with ${result.provider} / ${result.model}`);
  if (result.filePath) console.log(`Image saved: ${result.filePath}`);
  if (result.url) console.log(`Image URL: ${result.url}`);
  if (result.revisedPrompt) console.log(`Revised prompt: ${result.revisedPrompt}`);
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
  let imagePath = parsed.imagePath;
  const target = args[0]?.trim();
  const resolvePrompt = async (promptArgs: string[]): Promise<{ prompt: string; imagePath?: string }> => {
    if (!promptArgs.length && !imagePath) {
      const mode = await select("Select image mode", [
        { label: "Text to image / 文生图", value: "generate" },
        { label: "Reference local image / 参考本地图片", value: "edit" }
      ]);
      if (mode === "edit") {
        imagePath = (await text("Local reference image path (PNG, JPEG, WebP; max 20 MiB)"))
          .trim().replace(/^(["'])(.*)\1$/, "$2");
        if (!imagePath) throw new Error("Local reference image path is required.");
      }
    }
    const prompt = requirePrompt(promptArgs.join(" ").trim() || await text("Image prompt"));
    return { prompt, ...(imagePath ? { imagePath } : {}) };
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

function parseImageArgs(input: string[]): { args: string[]; imagePath?: string } {
  const args: string[] = [];
  let imagePath: string | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]!;
    if (argument === "--") { args.push(...input.slice(index + 1)); break; }
    if (argument === "--image" || argument.startsWith("--image=")) {
      if (imagePath !== undefined) throw new Error("Only one --image reference is supported.");
      const value = argument === "--image" ? input[++index] : argument.slice("--image=".length);
      if (!value?.trim() || value.startsWith("--")) throw new Error("--image requires a local file path.");
      imagePath = value.trim();
    } else {
      if (argument.startsWith("--")) throw new Error(`Unknown image option: ${argument.split("=")[0]}`);
      args.push(argument);
    }
  }
  return { args, imagePath };
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
