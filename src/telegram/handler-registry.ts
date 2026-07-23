import type { Bot } from "grammy";
import type { TelegramConfig } from "./config.js";
import type { TelegramEngineMap } from "./engine/registry.js";
import type { Engine } from "./engine/types.js";
import type { ApprovalManager } from "./interaction/approval.js";
import type { MemoryService } from "./memory/memory-service.js";
import type { SessionManager } from "./session/manager.js";

export type TelegramHandlerDeps = {
  bot: Bot;
  sessionManager: SessionManager;
  claudeEngine?: Engine;
  codexEngine?: Engine;
  approvalManager: ApprovalManager;
  config: TelegramConfig;
  engines: TelegramEngineMap;
  memoryService?: MemoryService;
};

export type TelegramHandlerRegistrar = (bot: Bot, deps: TelegramHandlerDeps) => void;

export class TelegramHandlerRegistry {
  private readonly handlers = new Map<string, TelegramHandlerRegistrar>();

  register(name: string, registrar: TelegramHandlerRegistrar): void {
    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new Error("Telegram handler name cannot be empty.");
    }
    this.handlers.set(normalizedName, registrar);
  }

  install(bot: Bot, deps: TelegramHandlerDeps): void {
    for (const registrar of this.handlers.values()) {
      registrar(bot, deps);
    }
  }

  list(): string[] {
    return [...this.handlers.keys()];
  }
}

const defaultTelegramHandlerRegistry = new TelegramHandlerRegistry();

export function registerTelegramHandler(name: string, registrar: TelegramHandlerRegistrar): void {
  defaultTelegramHandlerRegistry.register(name, registrar);
}

export function installTelegramHandlers(bot: Bot, deps: TelegramHandlerDeps): void {
  defaultTelegramHandlerRegistry.install(bot, deps);
}

export function listTelegramHandlers(): string[] {
  return defaultTelegramHandlerRegistry.list();
}
