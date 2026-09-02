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
};

export async function runImageCommand(args: string[]): Promise<void> {
  await refreshAllProviders();
  const [providers, cache] = await Promise.all([listProviders(), readCache()]);
  const input = await resolveImageCommandInput(args, providers, cache.providers);
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

  const target = args[0]?.trim();
  const namedProvider = target ? providers.find((provider) => provider.name === target) : undefined;
  if (target && !namedProvider) {
    const prompt = args.slice(1).join(" ").trim() || await text("Image prompt");
    return { target, prompt: requirePrompt(prompt) };
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
  const prompt = promptArgs.join(" ").trim() || await text("Image prompt");
  return { provider: provider.name, model, prompt: requirePrompt(prompt) };
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
