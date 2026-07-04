import path from "node:path";

export function getConfigRoot(): string {
  return process.env.AI_GATEWAY_HOME
    ? path.resolve(process.env.AI_GATEWAY_HOME)
    : process.cwd();
}

export function getProvidersPath(): string {
  return path.join(getConfigRoot(), "providers.json");
}

export function getCachePath(): string {
  return path.join(getConfigRoot(), ".ai-cache.json");
}

export function getUsagePath(): string {
  return path.join(getConfigRoot(), "usage.json");
}

export function getUsageHtmlPath(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../docs/USAGE.html");
}
