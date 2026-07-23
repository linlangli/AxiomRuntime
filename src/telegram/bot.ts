import { Bot } from "grammy";
import { loadBotConfig, loadTelegramConfig, type TelegramConfig } from "./config.js";
import { createTelegramEngines, type TelegramEngineMap } from "./engine/registry.js";
import { registerCallbackHandler } from "./handlers/callback.js";
import { registerCommands } from "./handlers/command.js";
import { registerDocumentHandler } from "./handlers/document.js";
import { registerMessageHandler } from "./handlers/message.js";
import { installTelegramHandlers, registerTelegramHandler } from "./handler-registry.js";
import { ApprovalManager } from "./interaction/approval.js";
import { safeResetChatCommandMenu, safeSetChatCommandMenu, safeSetDefaultCommandMenu } from "./interaction/command-menu.js";
import { getBotIdFromToken, MemoryService } from "./memory/memory-service.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore } from "./session/store.js";
import { writeTelegramLog } from "./log.js";
import { configureTelegramNetwork, createTelegramApiClientOptions } from "./network.js";

export type TelegramRuntime = {
  bot: Bot;
  config: TelegramConfig;
  store: SessionStore;
  sessionManager: SessionManager;
  memoryService: MemoryService;
  engines: TelegramEngineMap;
};

export async function createBot(botName?: string): Promise<TelegramRuntime> {
  const config = botName ? await loadBotConfig(botName) : await loadTelegramConfig();
  if (!config.token) {
    throw new Error("Telegram token is not configured. Run `ai telegram config set token <token>`.");
  }
  if (!config.allowAllUsers && !config.allowedUserIds.length) {
    throw new Error("No Telegram users are allowed. Run `ai telegram config set allowedUserIds <id>` or `ai telegram config set allowAllUsers true`.");
  }
  const proxyUrl = configureTelegramNetwork(config);
  if (proxyUrl) {
    await writeTelegramLog({
      action: "proxy_enabled",
      message: `Telegram API proxy enabled: ${proxyUrl}`
    });
  }

  const bot = new Bot(config.token, {
    client: createTelegramApiClientOptions(proxyUrl)
  });
  const store = new SessionStore(config.dbPath);
  const sessionManager = new SessionManager(store, config);
  const memoryService = new MemoryService({ botId: getBotIdFromToken(config.token) });
  const engines = createTelegramEngines();
  const approvalManager = new ApprovalManager(bot);

  sessionManager.cleanupExpired();
  const orphanCount = sessionManager.resetOrphanSessions();
  if (orphanCount > 0) {
    void writeTelegramLog({
      action: "orphan_reset",
      message: `Reset ${orphanCount} orphan session(s) stuck in running/waiting_approval`
    });
  }
  memoryService.cleanupExpired();
  void memoryService.backup();

  bot.catch((error) => {
    void writeTelegramLog({
      level: "error",
      action: "bot_error",
      message: error.error instanceof Error ? error.error.message : String(error.error),
      metadata: { updateId: error.ctx.update.update_id }
    });
  });

  bot.use(async (ctx, next) => {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
    await writeTelegramLog({
      action: "update_received",
      message: text ? `Received Telegram message: ${text.slice(0, 80)}` : `Received Telegram update ${ctx.update.update_id}`,
      metadata: {
        updateId: ctx.update.update_id,
        userId: ctx.from?.id,
        chatId: ctx.chat?.id,
        messageType: ctx.message ? "message" : "other",
        command: text?.startsWith("/") ? text.split(/\s+/, 1)[0] : undefined
      }
    });

    const userId = ctx.from?.id;
    if (!userId || (!config.allowAllUsers && !config.allowedUserIds.includes(userId))) {
      await ctx.reply("Access denied.");
      await writeTelegramLog({
        level: "warn",
        action: "access_denied",
        message: `Denied Telegram user ${userId ?? "(missing)"}`,
        metadata: { userId, chatId: ctx.chat?.id }
      });
      return;
    }
    await next();
  });

  const deps = {
    bot,
    sessionManager,
    claudeEngine: engines.claude,
    codexEngine: engines.codex,
    approvalManager,
    config,
    engines,
    memoryService
  };
  registerBuiltInTelegramHandlers();
  installTelegramHandlers(bot, deps);

  await safeSetDefaultCommandMenu(bot);
  await refreshStoredChatCommandMenus(bot, sessionManager);

  return {
    bot,
    config,
    store,
    sessionManager,
    memoryService,
    engines
  };
}

function registerBuiltInTelegramHandlers(): void {
  registerTelegramHandler("commands", registerCommands);
  registerTelegramHandler("callbacks", registerCallbackHandler);
  registerTelegramHandler("documents", registerDocumentHandler);
  registerTelegramHandler("messages", registerMessageHandler);
}

async function refreshStoredChatCommandMenus(bot: Bot, sessionManager: SessionManager): Promise<void> {
  const sessions = sessionManager.getActiveSessions();
  for (const session of sessions) {
    if (session.setupStep === "ready") {
      const customCommands = sessionManager.listCustomCommands(session.chatId, session.cwd);
      await safeSetChatCommandMenu(bot, session.chatId, session.engine, customCommands);
    } else {
      await safeResetChatCommandMenu(bot, session.chatId);
    }
  }
}
