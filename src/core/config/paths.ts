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

export function getModelPricingPath(): string {
  return path.join(getConfigRoot(), "model-pricing.json");
}

export function getSessionsPath(): string {
  return path.join(getConfigRoot(), "sessions.json");
}

export function getHermesRobotsPath(): string {
  return path.join(getConfigRoot(), "hermes.json");
}

export function getLegacyHermesRobotsPath(): string {
  return path.join(getConfigRoot(), "hermes-robots.json");
}

export function getHermesStatePath(): string {
  return path.join(getConfigRoot(), "hermes-state.json");
}

export function getIntegrationStatePath(): string {
  return path.join(getConfigRoot(), "integrations.json");
}

export function getExportsDir(): string {
  return path.join(getConfigRoot(), "exports");
}

export function getHermesExportPath(robotName: string): string {
  return path.join(getExportsDir(), `hermes-${robotName}.json`);
}

export function getHermesAllExportPath(): string {
  return path.join(getExportsDir(), "hermes-all.json");
}

export function getReportsDir(): string {
  return path.join(getConfigRoot(), "reports");
}

export function getReportPath(sessionId: string): string {
  return path.join(getReportsDir(), `${sessionId}.md`);
}

export function getLogPath(): string {
  return path.join(getConfigRoot(), ".ai-gateway.log");
}

export function getTelegramConfigPath(): string {
  return path.join(getConfigRoot(), "telegram.json");
}

export function getTelegramPidPath(): string {
  return path.join(getConfigRoot(), "telegram.pid");
}

export function getTelegramLogPath(): string {
  return path.join(getConfigRoot(), "telegram.log");
}

export function getTelegramDbPath(): string {
  return path.join(getConfigRoot(), "telegram.sqlite");
}

export function getTelegramBotDir(): string {
  return path.join(getConfigRoot(), "telegram", "bots");
}

export function getTelegramBotConfigPath(name: string): string {
  return path.join(getTelegramBotDir(), `${name}.json`);
}

export function getTelegramBotPidPath(name: string): string {
  return path.join(getTelegramBotDir(), `${name}.pid`);
}

export function getTelegramBotLogPath(name: string): string {
  return path.join(getTelegramBotDir(), `${name}.log`);
}

export function getTelegramBotDbPath(name: string): string {
  return path.join(getTelegramBotDir(), `${name}.sqlite`);
}

export function getMemoryDbPath(): string {
  return path.join(getConfigRoot(), "memory.sqlite");
}

export function getMemoryConfigPath(): string {
  return path.join(getConfigRoot(), "memory.json");
}

export function getMemoryBackupDir(): string {
  return path.join(getConfigRoot(), "memory.backup");
}

export function getContextDir(): string {
  return path.join(getProjectRoot(), ".ai-gateway");
}

export function getContextPath(): string {
  return path.join(getContextDir(), "context.md");
}

export function getContextPathForRoot(root: string): string {
  return path.join(root, ".ai-gateway", "context.md");
}

export function getUsageHtmlPath(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../docs/USAGE.html");
}
