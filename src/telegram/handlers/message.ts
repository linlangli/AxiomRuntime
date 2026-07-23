import fs from "node:fs";
import path from "node:path";
import { InputFile, type Bot, type Context } from "grammy";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { TelegramConfig, TelegramEngineName } from "../config.js";
import type { Engine, ExecutionResult } from "../engine/types.js";
import { getTelegramEngine, type TelegramEngineMap } from "../engine/registry.js";
import { recordProviderRuntimeFailure, recordProviderRuntimeSuccess } from "../../core/config/cache-store.js";
import { resolveProviderCandidatesForTool } from "../../core/runner/fallback.js";
import type { ApprovalManager } from "../interaction/approval.js";
import { parseTelegramCommand, resolveMappedCommand, safeSetChatCommandMenu } from "../interaction/command-menu.js";
import { Formatter, truncateText, splitPlainText, escapeHtml } from "../interaction/formatter.js";
import { applyPromptMiddlewares } from "../interaction/prompt-middleware.js";
import { ProgressReporter } from "../interaction/progress-reporter.js";
import { ResultStore } from "../interaction/result-store.js";
import { buildResultKeyboard } from "../interaction/keyboards.js";
import { emitTelegramTaskCompleted, emitTelegramTaskFailed } from "../lifecycle-registry.js";
import type { SessionManager, TelegramSession } from "../session/manager.js";
import type { MemoryService } from "../memory/memory-service.js";
import { writeTelegramLog } from "../log.js";
import { withTelegramNetworkRetry } from "../network-retry.js";
import { handleMemoryManageInput, handleRememberInput } from "./memory.js";
import { completeAgentProfile, remindSetup, setWorkdir, showReadyCard } from "./setup.js";
import { handleUsagePriceInput } from "./usage.js";

export type MessageHandlerDeps = {
  sessionManager: SessionManager;
  claudeEngine?: Engine;
  codexEngine?: Engine;
  engines?: Partial<TelegramEngineMap>;
  approvalManager: ApprovalManager;
  config: TelegramConfig;
  memoryService?: MemoryService;
};

export const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
export const CLI_INIT_TIMEOUT_MS = 3 * 60 * 1000;
const STALE_SESSION_THRESHOLD_MS = 20 * 60 * 1000;

export const resultStore = new ResultStore();

const MAX_PROMPT_HISTORY = 10;
type PromptMessageEntry = { messageId: number; prompt: string; replyToText?: string };
const promptMessageMap = new Map<number, PromptMessageEntry[]>();

function recordPromptMessage(chatId: number, entry: PromptMessageEntry): void {
  const list = promptMessageMap.get(chatId) ?? [];
  const existing = list.findIndex((item) => item.messageId === entry.messageId);
  if (existing >= 0) list.splice(existing, 1);
  list.push(entry);
  if (list.length > MAX_PROMPT_HISTORY) list.shift();
  promptMessageMap.set(chatId, list);
}

function getLatestPromptMessage(chatId: number): PromptMessageEntry | null {
  const list = promptMessageMap.get(chatId);
  return list?.length ? list[list.length - 1]! : null;
}

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
  progressThrottleMs?: number;
  replyToText?: string;
};

export function registerMessageHandler(bot: Bot, deps: MessageHandlerDeps): void {
  bot.on("edited_message:text", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const editedId = ctx.editedMessage.message_id;
    const previous = getLatestPromptMessage(chatId);
    if (!previous || previous.messageId !== editedId) return;
    const newText = ctx.editedMessage.text?.trim();
    if (!newText || newText.startsWith("/") || newText === previous.prompt) return;

    const session = deps.sessionManager.getOrCreate(chatId);
    if (session.status === "running" || session.status === "waiting_approval") {
      abortTelegramEngines(deps, chatId);
      deps.approvalManager.resolveAll(chatId, false);
    }
    deps.sessionManager.prepareEditedPrompt(chatId, previous.prompt);
    const replyToText = readReplyContext(ctx.editedMessage) ?? previous.replyToText;
    recordPromptMessage(chatId, { messageId: editedId, prompt: newText, replyToText });
    await executePrompt(ctx, deps, newText, undefined, { replyToText });
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const session = deps.sessionManager.getOrCreate(chatId);
    if (text.startsWith("/")) {
      void writeTelegramLog({ action: "slash_command_received", message: `cmd=${text.split(/\s/)[0]} setupStep=${session.setupStep} chatId=${chatId}` });
      if (session.setupStep === "command_name") {
        await handleCommandNameInput(ctx, deps, text, session);
        return;
      }
      if (session.setupStep === "command_template") {
        await handleCommandTemplateInput(ctx, deps, text, session, bot);
        return;
      }
      await executeMappedSlashCommand(ctx, deps, text, session);
      return;
    }
    if (await handleMemoryManageInput(ctx, deps, text, session)) {
      return;
    }
    if (await handleRememberInput(ctx, deps, text, session)) {
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
    if (session.setupStep === "command_name") {
      await handleCommandNameInput(ctx, deps, text, session);
      return;
    }
    if (session.setupStep === "command_template") {
      await handleCommandTemplateInput(ctx, deps, text, session, bot);
      return;
    }
    if (await remindSetup(ctx, deps, session)) return;
    const replyToText = readReplyContext(ctx.message);
    const messageId = ctx.message.message_id;
    recordPromptMessage(chatId, { messageId, prompt: text, replyToText });
    await executePrompt(ctx, deps, text, undefined, { replyToText });
  });
}

function readReplyContext(message: { reply_to_message?: { text?: string; caption?: string } } | undefined): string | undefined {
  const reply = message?.reply_to_message;
  const text = reply?.text ?? reply?.caption;
  return text?.trim() || undefined;
}

function abortTelegramEngines(deps: MessageHandlerDeps, chatId: number): void {
  const engines = new Set<Engine>();
  if (deps.engines?.claude) engines.add(deps.engines.claude);
  if (deps.engines?.codex) engines.add(deps.engines.codex);
  if (deps.claudeEngine) engines.add(deps.claudeEngine);
  if (deps.codexEngine) engines.add(deps.codexEngine);
  for (const engine of engines) engine.abort(chatId);
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
  const customCommands = deps.sessionManager.listCustomCommands(session.chatId, session.cwd);
  const mapped = resolveMappedCommand(session.engine, parsed.command, customCommands);
  if (!mapped) {
    await ctx.reply("未知命令，请通过 / 打开当前 CLI 可用命令。");
    return;
  }
  if (mapped.prompt === "/__register_command") {
    deps.sessionManager.update(session.id, { setupStep: "command_name" });
    await ctx.reply(Formatter.commandNamePrompt(), {
      reply_markup: { inline_keyboard: [[{ text: "关闭", callback_data: "command:cancel" }]] }
    });
    return;
  }
  if (mapped.prompt.startsWith("/__custom_")) {
    await executeCustomCommand(ctx, deps, parsed.command, parsed.args, session);
    return;
  }
  const prompt = [mapped.prompt, parsed.args].filter(Boolean).join(" ");
  await executePrompt(ctx, deps, prompt, session.engine);
}

export async function runCliInit(ctx: Context, deps: MessageHandlerDeps, engine?: TelegramEngineName, options: { edit?: boolean } = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId) {
    const session = deps.sessionManager.getOrCreate(chatId);
    if (session.cwd && fs.existsSync(path.join(session.cwd, "CLAUDE.md"))) {
      try {
        await ctx.editMessageText("🤖 介绍一下我和你吧，可以帮你构建画像哦", { reply_markup: { inline_keyboard: [] } });
      } catch {
        // Best-effort notification.
      }
      return;
    }
  }
  try {
    if (options.edit) {
      await ctx.editMessageText("🤖 等我熟悉一下当前工作目录哦", { reply_markup: { inline_keyboard: [] } });
    } else {
      await ctx.reply("🤖 等我熟悉一下当前工作目录哦");
    }
  } catch {
    // Best-effort notification.
  }
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
    const staleMs = Date.now() - new Date(session.lastActiveAt).getTime();
    if (staleMs > STALE_SESSION_THRESHOLD_MS) {
      session = deps.sessionManager.update(session.id, { status: "idle" });
    } else {
      await ctx.reply("已有任务正在运行，请等待完成或使用 /stop 终止。");
      return false;
    }
  }

  session = deps.sessionManager.update(session.id, {
    status: "running",
    messageCount: session.messageCount + 1
  });
  const stopTypingStatus = startTypingStatus(ctx, chatId);
  const reporter = new ProgressReporter(ctx.api, chatId, {
    silent: options.silentSuccess ?? false,
    throttleMs: options.progressThrottleMs
  });

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
        memoryService: deps.memoryService,
        includeAgentContext: options.includeAgentContext !== false,
        replyToText: options.replyToText
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
          imagePaths: session.attachments
            .filter((attachment) => attachment.kind === "image" || attachment.mimeType?.startsWith("image/"))
            .map((attachment) => attachment.path),
          timeoutMs: options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
          onProgress: (update) => reporter.update(update),
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
        await reporter.update({
          phase: "thinking",
          message: `正在切换 provider：${attempt.providerLabel} → ${next.providerLabel}`
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
    cleanupConsumedAttachments(session.attachments);
    deps.sessionManager.recordProviderUsage(session.id, {
      provider: result.provider ?? deps.config.provider ?? "unknown",
      model: result.model ?? deps.config.model,
      costUsd: result.cost,
      usage: result.usage
    });
    if (!options.silentSuccess) {
      await sendResult(ctx, session.engine, result, deps.config.maxOutputLength, reporter);
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
      await sendFailure(ctx, reporter, message);
    }
    return false;
  } finally {
    await reporter.finalize();
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
  maxOutputLength: number,
  reporter?: ProgressReporter
): Promise<void> {
  const chatId = ctx.chat?.id;
  const hasFullOutput = (result.response || "").trim().length > 200;
  const hasDiff = Boolean(result.diff);

  if (chatId) resultStore.set(chatId, result);

  const cardHtml = Formatter.resultCard(result);
  const keyboard = buildResultKeyboard(hasFullOutput, hasDiff);

  if (cardHtml.length <= 4000) {
    const replaced = await reporter?.replaceWithHtml(
      cardHtml,
      truncateText((result.response || "(empty)").trim(), maxOutputLength),
      { reply_markup: { inline_keyboard: keyboard.inline_keyboard } }
    );
    if (replaced) return;
    await replyHtmlWithPlainFallback(ctx, cardHtml, truncateText((result.response || "(empty)").trim(), maxOutputLength), keyboard);
    return;
  }

  void engine;
  const footer = formatResultFooter(result);
  const fileSummary = Formatter.fileChangeSummary(result.filesChanged, result.diff);
  const suffix = [fileSummary, footer].filter(Boolean).join("\n\n");
  const formatted = Formatter.taskCompleted(engine, result, Math.min(maxOutputLength, 2500))
    + (suffix ? `\n\n${suffix}` : "");

  if (formatted.length <= 4000 && result.response.length <= maxOutputLength) {
    if (await reporter?.replaceWithHtml(formatted, truncateText((result.response || "(empty)").trim(), maxOutputLength))) {
      return;
    }
    await replyHtmlWithPlainFallback(ctx, formatted, truncateText((result.response || "(empty)").trim(), maxOutputLength));
    return;
  }

  const responseText = (result.response || "(empty)").trim();
  if (responseText.length <= 12000) {
    const chunks = splitPlainText(responseText, 3800);
    const firstChunk = chunks[0] + (chunks.length === 1 && suffix ? `\n\n${suffix}` : "");
    if (!(await reporter?.replaceWithHtml(firstChunk, chunks[0]))) {
      await withTelegramNetworkRetry(() => ctx.reply(firstChunk));
    }
    for (let i = 1; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const text = isLast && suffix ? `${chunks[i]}\n\n${suffix}` : chunks[i];
      await withTelegramNetworkRetry(() => ctx.reply(text));
    }
    return;
  }

  const attachmentNotice = "Output is attached as a file.";
  const formattedNotice = Formatter.taskCompleted(engine, { ...result, response: attachmentNotice }, 800)
    + (suffix ? `\n\n${suffix}` : "");
  if (!(await reporter?.replaceWithHtml(formattedNotice, attachmentNotice))) {
    await withTelegramNetworkRetry(() => ctx.reply(formattedNotice, { parse_mode: "HTML" }));
  }
  await withTelegramNetworkRetry(() =>
    ctx.replyWithDocument(new InputFile(Buffer.from(result.response || "(empty)", "utf8"), "ai-gateway-output.md"), {
      caption: "Full output"
    })
  );
  if (result.diff) {
    await withTelegramNetworkRetry(() =>
      ctx.replyWithDocument(new InputFile(Buffer.from(result.diff!, "utf8"), "changes.diff"), {
        caption: "Diff"
      })
    );
  }
}

async function sendFailure(ctx: Context, reporter: ProgressReporter, message: string): Promise<void> {
  const hint = classifyErrorHint(message);
  const display = hint ? `${message}\n\n💡 ${hint}` : message;
  const html = Formatter.taskFailed(display);
  if (await reporter.replaceWithHtml(html, `Failed\n\n${truncateText(display, 1500)}`)) {
    return;
  }
  await withTelegramNetworkRetry(() => ctx.reply(html, { parse_mode: "HTML" }));
}

function classifyErrorHint(message: string): string | null {
  if (/Failed to find .* CLI/i.test(message)) {
    return "CLI 未安装，请确认 claude 或 codex 已正确安装并在 PATH 中。";
  }
  if (/timed?\s*out/i.test(message)) {
    return "任务超时，可使用 /stop 提前终止长任务。";
  }
  if (/Dangerous command denied/i.test(message)) {
    return null;
  }
  if (/任务已停止/i.test(message)) {
    return null;
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|502|503|429/i.test(message)) {
    return "Provider 连接异常，系统已尝试 fallback。请稍后重试或检查网络。";
  }
  return null;
}

async function replyHtmlWithPlainFallback(ctx: Context, html: string, fallbackText: string, keyboard?: import("grammy").InlineKeyboard): Promise<void> {
  try {
    const extra: Record<string, unknown> = { parse_mode: "HTML" };
    if (keyboard) extra.reply_markup = keyboard;
    await withTelegramNetworkRetry(() => ctx.reply(html, extra));
  } catch {
    await withTelegramNetworkRetry(() => ctx.reply(fallbackText || "(empty)"));
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

function cleanupConsumedAttachments(attachments: TelegramSession["attachments"]): void {
  for (const attachment of attachments) {
    try {
      fs.unlinkSync(attachment.path);
    } catch {
      // Temporary attachment cleanup is best-effort. Failed executions retain
      // their attachments so the user can retry without uploading again.
    }
  }
}

function formatResultFooter(result: ExecutionResult): string {
  const parts: string[] = [];
  if (result.duration && result.duration > 0) {
    const seconds = Math.round(result.duration / 1000);
    parts.push(seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`);
  }
  if (result.provider) parts.push(result.provider);
  if (result.model) parts.push(result.model);
  if (!parts.length) return "";
  return `<i>⏱ ${parts.join(" · ")}</i>`;
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

const execAsync = promisify(exec);

const pendingCommandRegistration = new Map<number, { name: string; params: string[]; description: string }>();

async function handleCommandNameInput(
  ctx: Context,
  deps: MessageHandlerDeps,
  text: string,
  session: TelegramSession
): Promise<void> {
  const input = text.replace(/^\//, "").trim();
  if (!input) {
    await ctx.reply(Formatter.commandNamePrompt(), {
      reply_markup: { inline_keyboard: [[{ text: "关闭", callback_data: "command:cancel" }]] }
    });
    return;
  }
  const params: string[] = [];
  input.replace(/\[(\w+)\]/g, (_, p) => {
    params.push(p);
    return "";
  });
  const name = input.split(/\s/)[0]!.replace(/\[.*$/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!name) {
    await ctx.reply(Formatter.commandNamePrompt(), {
      reply_markup: { inline_keyboard: [[{ text: "关闭", callback_data: "command:cancel" }]] }
    });
    return;
  }
  const description = `/${input}`;
  pendingCommandRegistration.set(session.chatId, { name, params, description });
  deps.sessionManager.update(session.id, { setupStep: "command_template" });
  await ctx.reply(Formatter.commandTemplatePrompt(params), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "返回", callback_data: "command:back" }]] }
  });
}

async function handleCommandTemplateInput(
  ctx: Context,
  deps: MessageHandlerDeps,
  text: string,
  session: TelegramSession,
  bot: Bot
): Promise<void> {
  const pending = pendingCommandRegistration.get(session.chatId);
  if (!pending) {
    deps.sessionManager.update(session.id, { setupStep: "ready" });
    await ctx.reply("注册流程已失效，请重新 /command");
    return;
  }
  pendingCommandRegistration.delete(session.chatId);
  const cmd = { ...pending, template: text.trim() };
  deps.sessionManager.addCustomCommand(session.chatId, session.cwd, cmd);
  deps.sessionManager.update(session.id, { setupStep: "ready" });
  const customCommands = deps.sessionManager.listCustomCommands(session.chatId, session.cwd);
  await safeSetChatCommandMenu(bot, session.chatId, session.engine, customCommands);
  await ctx.reply(Formatter.commandRegistered(cmd.name, cmd.description), { parse_mode: "HTML" });
}

async function executeCustomCommand(
  ctx: Context,
  deps: MessageHandlerDeps,
  commandName: string,
  argsText: string,
  session: TelegramSession
): Promise<void> {
  const commands = deps.sessionManager.listCustomCommands(session.chatId, session.cwd);
  const cmd = commands.find((c) => c.name === commandName);
  if (!cmd) {
    await ctx.reply("自定义命令不存在。");
    return;
  }
  const argValues = parseCustomCommandArgs(argsText, cmd.params.length);
  let shell = cmd.template;
  for (let i = 0; i < cmd.params.length; i++) {
    const value = argValues[i] ?? "";
    shell = shell.replaceAll(`[${cmd.params[i]}]`, value);
  }
  await ctx.reply(`⚙️ 执行中：<code>${escapeHtml(shell)}</code>`, { parse_mode: "HTML" });
  try {
    const { stdout, stderr } = await execAsync(shell, { cwd: session.cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    const output = (stdout || stderr || "（无输出）").trim();
    if (output.length <= 3800) {
      await ctx.reply(`<pre>${escapeHtml(output)}</pre>`, { parse_mode: "HTML" });
    } else {
      await ctx.replyWithDocument(new InputFile(Buffer.from(output, "utf-8"), "output.txt"));
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.length <= 3800) {
      await ctx.reply(`❌ 执行失败：\n<pre>${escapeHtml(msg)}</pre>`, { parse_mode: "HTML" });
    } else {
      await ctx.replyWithDocument(new InputFile(Buffer.from(msg, "utf-8"), "error.txt"));
    }
  }
}

function parseCustomCommandArgs(argsText: string, paramCount: number): string[] {
  if (!argsText || paramCount === 0) return [];
  const parts = argsText.split(/\s+/);
  if (parts.length <= paramCount) return parts;
  const result = parts.slice(0, paramCount - 1);
  result.push(parts.slice(paramCount - 1).join(" "));
  return result;
}
