import { InputFile, type Bot, type Context } from "grammy";
import type { TelegramConfig, TelegramEngineName } from "../config.js";
import type { Engine, ExecutionResult } from "../engine/types.js";
import { getTelegramEngine, type TelegramEngineMap } from "../engine/registry.js";
import { recordProviderRuntimeFailure, recordProviderRuntimeSuccess } from "../../core/config/cache-store.js";
import { resolveProviderCandidatesForTool } from "../../core/runner/fallback.js";
import type { ApprovalManager } from "../interaction/approval.js";
import { parseTelegramCommand, resolveMappedCommand } from "../interaction/command-menu.js";
import { Formatter, truncateText } from "../interaction/formatter.js";
import { applyPromptMiddlewares } from "../interaction/prompt-middleware.js";
import { emitTelegramTaskCompleted, emitTelegramTaskFailed } from "../lifecycle-registry.js";
import type { SessionManager, TelegramSession } from "../session/manager.js";
import { writeTelegramLog } from "../log.js";
import { completeAgentProfile, remindSetup, setWorkdir, showReadyCard } from "./setup.js";
import { handleUsagePriceInput } from "./usage.js";

export type MessageHandlerDeps = {
  sessionManager: SessionManager;
  claudeEngine?: Engine;
  codexEngine?: Engine;
  engines?: Partial<TelegramEngineMap>;
  approvalManager: ApprovalManager;
  config: TelegramConfig;
};

export const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
export const CLI_INIT_TIMEOUT_MS = 3 * 60 * 1000;

type ProviderAttempt = {
  providerName?: string;
  modelName?: string;
  providerLabel: string;
  modelLabel?: string;
  fallbackFrom?: string;
  preferred: boolean;
};

export type ExecutePromptOptions = {
  silentSuccess?: boolean;
  suppressFailureReply?: boolean;
  includeAgentContext?: boolean;
  skipSetupReminder?: boolean;
  timeoutMs?: number;
};

export function registerMessageHandler(bot: Bot, deps: MessageHandlerDeps): void {
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const session = deps.sessionManager.getOrCreate(chatId);
    if (text.startsWith("/")) {
      await executeMappedSlashCommand(ctx, deps, text, session);
      return;
    }
    if (session.setupStep === "custom_workdir") {
      await setWorkdir(ctx, deps, text, {
        fromCustomInput: true,
        afterSet: (next) => runCliInit(ctx, deps, next.engine)
      });
      return;
    }
    if (session.setupStep === "edit_custom_workdir") {
      await setWorkdir(ctx, deps, text, {
        fromCustomInput: true,
        returnToReady: true,
        afterSet: (next) => runCliInit(ctx, deps, next.engine)
      });
      return;
    }
    if (session.setupStep === "usage_price_input") {
      await handleUsagePriceInput(ctx, deps, text);
      return;
    }
    if (session.setupStep === "agent_profile") {
      const next = await completeAgentProfile(ctx, deps, text, { showReady: false });
      if (next) {
        await showReadyCard(ctx, deps, next);
      }
      return;
    }
    if (await remindSetup(ctx, deps, session)) return;
    await executePrompt(ctx, deps, text);
  });
}

async function executeMappedSlashCommand(
  ctx: Context,
  deps: MessageHandlerDeps,
  text: string,
  session: TelegramSession
): Promise<void> {
  const parsed = parseTelegramCommand(text);
  if (!parsed) return;
  if (await remindSetup(ctx, deps, session)) return;
  const mapped = resolveMappedCommand(session.engine, parsed.command);
  if (!mapped) {
    await ctx.reply("未知命令，请通过 / 打开当前 CLI 可用命令。");
    return;
  }
  const prompt = [mapped.prompt, parsed.args].filter(Boolean).join(" ");
  await executePrompt(ctx, deps, prompt, session.engine);
}

export async function runCliInit(ctx: Context, deps: MessageHandlerDeps, engine?: TelegramEngineName): Promise<void> {
  await executePrompt(ctx, deps, "/init", engine, {
    silentSuccess: true,
    suppressFailureReply: true,
    includeAgentContext: false,
    skipSetupReminder: true,
    timeoutMs: CLI_INIT_TIMEOUT_MS
  });
}

export async function executePrompt(
  ctx: Context,
  deps: MessageHandlerDeps,
  prompt: string,
  forcedEngine?: TelegramEngineName,
  options: ExecutePromptOptions = {}
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  const text = prompt.trim();
  if (!text) {
    await ctx.reply("Prompt is empty.");
    return false;
  }

  return deps.sessionManager.runExclusive(chatId, () =>
    executePromptLocked(ctx, deps, text, forcedEngine, options)
  );
}

async function executePromptLocked(
  ctx: Context,
  deps: MessageHandlerDeps,
  text: string,
  forcedEngine?: TelegramEngineName,
  options: ExecutePromptOptions = {}
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  let session = deps.sessionManager.getOrCreate(chatId);
  if (!options.skipSetupReminder && await remindSetup(ctx, deps, session)) return false;
  if (forcedEngine && session.engine !== forcedEngine) {
    session = deps.sessionManager.update(session.id, {
      engine: forcedEngine,
      engineSessionId: null,
      botContextFingerprint: null
    });
  }

  if (session.status === "running" || session.status === "waiting_approval") {
    await ctx.reply("已有任务正在运行，请等待完成。");
    return false;
  }

  session = deps.sessionManager.update(session.id, {
    status: "running",
    messageCount: session.messageCount + 1
  });
  const stopTypingStatus = startTypingStatus(ctx, chatId);

  try {
    const engine = resolveMessageEngine(deps, session.engine);
    const attempts = await resolveTelegramProviderAttempts(session.engine, deps.config);
    let result: ExecutionResult | null = null;
    let successfulAttempt: ProviderAttempt | null = null;
    let lastError: unknown = null;

    for (const [index, attempt] of attempts.entries()) {
      const resume = attempt.preferred ? session.engineSessionId : null;
      const promptWithContext = await applyPromptMiddlewares({
        chatId,
        prompt: text,
        session,
        engine: session.engine,
        resume,
        includeAgentContext: options.includeAgentContext !== false
      });
      try {
        result = await engine.execute({
          chatId,
          prompt: promptWithContext,
          cwd: session.cwd,
          resume,
          permissionMode: session.permissionMode,
          providerName: attempt.providerName,
          modelName: attempt.modelName,
          timeoutMs: options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
          onPermission: async (req) => {
            if (session.approveAll) return true;
            deps.sessionManager.update(session.id, { status: "waiting_approval" });
            const approved = await deps.approvalManager.request(chatId, req);
            deps.sessionManager.update(session.id, { status: "running" });
            return approved;
          }
        });
        successfulAttempt = attempt;
        if (attempt.providerName) {
          await recordProviderRuntimeSuccess(attempt.providerName);
        }
        break;
      } catch (error) {
        lastError = error;
        const next = attempts[index + 1];
        if (attempt.providerName && !isNonFallbackTelegramError(error)) {
          await recordProviderRuntimeFailure(attempt.providerName, error);
        }
        if (!next || isNonFallbackTelegramError(error)) {
          throw error;
        }
        await writeTelegramFallbackLog({
          chatId,
          engine: session.engine,
          from: attempt.providerLabel,
          to: next.providerLabel,
          model: attempt.modelLabel,
          nextModel: next.modelLabel,
          error
        });
      }
    }

    if (!result || !successfulAttempt) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Telegram task failed."));
    }

    const conversation = !options.silentSuccess && !text.trimStart().startsWith("/")
      ? deps.sessionManager.appendConversationTurn(session.id, {
          user: text,
          assistant: result.response || "(empty)"
        }).conversation
      : session.conversation;
    const completedSession = deps.sessionManager.update(session.id, {
      engineSessionId: successfulAttempt.preferred ? result.sessionId ?? session.engineSessionId : null,
      conversation,
      status: "idle",
      attachments: []
    });
    deps.sessionManager.recordProviderUsage(session.id, {
      provider: result.provider ?? deps.config.provider ?? "unknown",
      model: result.model ?? deps.config.model,
      costUsd: result.cost,
      usage: result.usage
    });
    if (!options.silentSuccess) {
      await sendResult(ctx, session.engine, result, deps.config.maxOutputLength);
    }
    await writeTelegramLog({
      action: "task_completed",
      message: `Completed ${session.engine} task for Telegram chat ${chatId}`,
      metadata: {
        chatId,
        engine: session.engine,
        provider: result.provider,
        model: result.model,
        sessionId: result.sessionId,
        duration: result.duration,
        fallbackFrom: successfulAttempt.fallbackFrom ?? null,
        preferredProvider: successfulAttempt.preferred
      }
    });
    await emitTelegramTaskCompleted({
      chatId,
      engine: session.engine,
      session: completedSession,
      result,
      fallbackFrom: successfulAttempt.fallbackFrom ?? null,
      preferredProvider: successfulAttempt.preferred
    });
    return true;
  } catch (error) {
    const failedSession = deps.sessionManager.update(session.id, { status: "idle" });
    const message = error instanceof Error ? error.message : String(error);
    await writeTelegramLog({
      level: "error",
      action: "task_failed",
      message,
      metadata: { chatId, engine: session.engine }
    });
    await emitTelegramTaskFailed({
      chatId,
      engine: session.engine,
      session: failedSession,
      error
    });
    if (!options.suppressFailureReply) {
      await ctx.reply(Formatter.taskFailed(message), { parse_mode: "HTML" });
    }
    return false;
  } finally {
    stopTypingStatus();
  }
}

function resolveMessageEngine(deps: MessageHandlerDeps, name: TelegramEngineName): Engine {
  if (deps.engines) {
    return getTelegramEngine(deps.engines, name);
  }
  const legacyEngine = name === "codex" ? deps.codexEngine : deps.claudeEngine;
  if (!legacyEngine) {
    throw new Error(`Telegram engine is not registered: ${name}`);
  }
  return legacyEngine;
}

async function sendResult(
  ctx: Context,
  engine: TelegramEngineName,
  result: ExecutionResult,
  maxOutputLength: number
): Promise<void> {
  const formatted = Formatter.taskCompleted(engine, result, Math.min(maxOutputLength, 2500));
  if (formatted.length <= 4000 && result.response.length <= maxOutputLength) {
    await replyHtmlWithPlainFallback(ctx, formatted, truncateText((result.response || "(empty)").trim(), maxOutputLength));
    return;
  }

  const attachmentNotice = "Output is attached as a file.";
  await ctx.reply(
    Formatter.taskCompleted(engine, { ...result, response: attachmentNotice }, 800),
    { parse_mode: "HTML" }
  );
  await ctx.replyWithDocument(new InputFile(Buffer.from(result.response || "(empty)", "utf8"), "ai-gateway-output.md"), {
    caption: "Full output"
  });
  if (result.diff) {
    await ctx.replyWithDocument(new InputFile(Buffer.from(result.diff, "utf8"), "changes.diff"), {
      caption: "Diff"
    });
  }
}

async function replyHtmlWithPlainFallback(ctx: Context, html: string, fallbackText: string): Promise<void> {
  try {
    await ctx.reply(html, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(fallbackText || "(empty)");
  }
}

async function resolveTelegramProviderAttempts(
  engine: TelegramEngineName,
  config: TelegramConfig
): Promise<ProviderAttempt[]> {
  try {
    const candidates = await resolveProviderCandidatesForTool(engine, config.provider, config.model);
    if (candidates.length) {
      return candidates.map((candidate, index) => ({
        providerName: candidate.provider.name,
        modelName: candidate.model,
        providerLabel: candidate.provider.name,
        modelLabel: candidate.model,
        fallbackFrom: candidate.fallbackFrom,
        preferred: isPreferredProviderAttempt(index, candidate.provider.name, candidate.model, candidate.fallbackFrom, config)
      }));
    }
  } catch (error) {
    await writeTelegramLog({
      level: "warn",
      action: "provider_candidates_unavailable",
      message: error instanceof Error ? error.message : String(error),
      metadata: { engine, provider: config.provider ?? null, model: config.model ?? null }
    });
  }

  return [{
    providerName: config.provider,
    modelName: config.model,
    providerLabel: config.provider ?? "auto",
    modelLabel: config.model,
    preferred: true
  }];
}

function isPreferredProviderAttempt(
  index: number,
  providerName: string,
  model: string,
  fallbackFrom: string | undefined,
  config: TelegramConfig
): boolean {
  if (fallbackFrom) return false;
  if (index !== 0) return false;
  if (config.provider && providerName !== config.provider) return false;
  if (config.model && model !== config.model) return false;
  return true;
}

function isNonFallbackTelegramError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Dangerous command denied|任务已停止|Failed to find .* CLI|Run `ai doctor`/.test(message);
}

async function writeTelegramFallbackLog(input: {
  chatId: number;
  engine: TelegramEngineName;
  from: string;
  to: string;
  model?: string;
  nextModel?: string;
  error: unknown;
}): Promise<void> {
  const error = input.error instanceof Error ? input.error.message : String(input.error);
  await writeTelegramLog({
    level: "warn",
    action: "runtime_provider_fallback_retry",
    message: `Provider fallback ${input.from} -> ${input.to} for Telegram ${input.engine}.`,
    metadata: {
      chatId: input.chatId,
      engine: input.engine,
      from: input.from,
      to: input.to,
      model: input.model ?? null,
      nextModel: input.nextModel ?? null,
      error: summarizeError(error)
    }
  });
}

function summarizeError(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function startTypingStatus(ctx: Pick<Context, "api">, chatId: number): () => void {
  let stopped = false;
  const sendTyping = async (): Promise<void> => {
    if (stopped) return;
    try {
      await ctx.api.sendChatAction(chatId, "typing");
    } catch {
      // Chat actions are best-effort and should never affect task execution.
    }
  };

  void sendTyping();
  const interval = setInterval(() => void sendTyping(), 4000);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
