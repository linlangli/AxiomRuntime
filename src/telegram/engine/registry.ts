import type { TelegramEngineName } from "../config.js";
import { ClaudeEngine } from "./claude-engine.js";
import { CodexEngine } from "./codex-engine.js";
import type { Engine } from "./types.js";

export type TelegramEngineFactory = () => Engine;
export type TelegramEngineMap = Record<TelegramEngineName, Engine>;

const factories = new Map<TelegramEngineName, TelegramEngineFactory>();

export function registerTelegramEngine(name: TelegramEngineName, factory: TelegramEngineFactory): void {
  factories.set(name, factory);
}

export function createTelegramEngines(): TelegramEngineMap {
  return {
    claude: createTelegramEngine("claude"),
    codex: createTelegramEngine("codex")
  };
}

export function createTelegramEngine(name: TelegramEngineName): Engine {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(`Unknown Telegram engine: ${name}`);
  }
  return factory();
}

export function getTelegramEngine(engines: Partial<Record<TelegramEngineName, Engine>>, name: TelegramEngineName): Engine {
  const engine = engines[name];
  if (!engine) {
    throw new Error(`Telegram engine is not registered: ${name}`);
  }
  return engine;
}

export function listTelegramEngineNames(): TelegramEngineName[] {
  return [...factories.keys()];
}

registerTelegramEngine("claude", () => new ClaudeEngine());
registerTelegramEngine("codex", () => new CodexEngine());
