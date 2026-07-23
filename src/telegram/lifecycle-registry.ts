import type { TelegramEngineName } from "./config.js";
import type { ExecutionResult } from "./engine/types.js";
import { writeTelegramLog } from "./log.js";
import type { TelegramSession } from "./session/manager.js";

export type TelegramTaskCompletedEvent = {
  chatId: number;
  engine: TelegramEngineName;
  session: TelegramSession;
  result: ExecutionResult;
  fallbackFrom: string | null;
  preferredProvider: boolean;
};

export type TelegramTaskFailedEvent = {
  chatId: number;
  engine: TelegramEngineName;
  session: TelegramSession;
  error: unknown;
};

export type TelegramTaskLifecycleHook = {
  onTaskCompleted?(event: TelegramTaskCompletedEvent): void | Promise<void>;
  onTaskFailed?(event: TelegramTaskFailedEvent): void | Promise<void>;
};

export class TelegramTaskLifecycleRegistry {
  private readonly hooks = new Set<TelegramTaskLifecycleHook>();

  register(hook: TelegramTaskLifecycleHook): () => void {
    this.hooks.add(hook);
    return () => {
      this.hooks.delete(hook);
    };
  }

  async emitTaskCompleted(event: TelegramTaskCompletedEvent): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onTaskCompleted) continue;
      await this.callHook("task_completed", () => hook.onTaskCompleted!(event));
    }
  }

  async emitTaskFailed(event: TelegramTaskFailedEvent): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onTaskFailed) continue;
      await this.callHook("task_failed", () => hook.onTaskFailed!(event));
    }
  }

  private async callHook(action: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      await writeTelegramLog({
        level: "error",
        action: "lifecycle_hook_failed",
        message: error instanceof Error ? error.message : String(error),
        metadata: { lifecycleAction: action }
      });
    }
  }
}

const defaultTelegramLifecycleRegistry = new TelegramTaskLifecycleRegistry();

export function registerTelegramTaskLifecycleHook(hook: TelegramTaskLifecycleHook): () => void {
  return defaultTelegramLifecycleRegistry.register(hook);
}

export function emitTelegramTaskCompleted(event: TelegramTaskCompletedEvent): Promise<void> {
  return defaultTelegramLifecycleRegistry.emitTaskCompleted(event);
}

export function emitTelegramTaskFailed(event: TelegramTaskFailedEvent): Promise<void> {
  return defaultTelegramLifecycleRegistry.emitTaskFailed(event);
}
