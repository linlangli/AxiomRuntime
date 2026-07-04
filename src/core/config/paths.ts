import path from "node:path";
import os from "node:os";

export function getConfigRoot(): string {
  return process.env.AI_GATEWAY_HOME
    ? path.resolve(process.env.AI_GATEWAY_HOME)
    : path.join(os.homedir(), ".ai-gateway");
}

export function getProjectRoot(): string {
  return process.cwd();
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

export function getSessionsPath(): string {
  return path.join(getConfigRoot(), "sessions.json");
}

export function getLogPath(): string {
  return path.join(getConfigRoot(), ".ai-gateway.log");
}

export function getContextDir(): string {
  return path.join(getProjectRoot(), ".ai-gateway");
}

export function getContextPath(): string {
  return path.join(getContextDir(), "context.md");
}

export function getUsageHtmlPath(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../docs/USAGE.html");
}
