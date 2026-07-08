import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { InputFile, type Bot, type Context } from "grammy";
import type { TelegramConfig, TelegramEngineName } from "../config.js";
import type { Engine, ExecutionResult } from "../engine/types.js";
import type { ApprovalManager } from "../interaction/approval.js";
import { parseTelegramCommand, resolveMappedCommand } from "../interaction/command-menu.js";
import { Formatter, truncateText } from "../interaction/formatter.js";
import type { SessionManager, TelegramSession } from "../session/manager.js";
import { writeTelegramLog } from "../log.js";
import { BOT_PROFILE_FILENAME, buildAgentProfileGenerationPrompt, completeAgentProfile, remindSetup, setWorkdir, showReadyCard } from "./setup.js";
import { handleUsagePriceInput } from "./usage.js";

export type MessageHandlerDeps = {
  sessionManager: SessionManager;
  claudeEngine: Engine;
  codexEngine: Engine;
  approvalManager: ApprovalManager;
  config: TelegramConfig;
};

export const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
export const AGENT_PROFILE_GENERATION_TIMEOUT_MS = 2 * 60 * 1000;
export const CLI_INIT_TIMEOUT_MS = 3 * 60 * 1000;
const RECENT_CONVERSATION_TURNS = 4;

export type ExecutePromptOptions = {
  silentSuccess?: boolean;
  suppressFailureReply?: boolean;
  includeAgentContext?: boolean;
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
      await setWorkdir(ctx, deps, text, { fromCustomInput: true });
      return;
    }
    if (session.setupStep === "edit_custom_workdir") {
      await setWorkdir(ctx, deps, text, { fromCustomInput: true, returnToReady: true });
      return;
    }
    if (session.setupStep === "usage_price_input") {
      await handleUsagePriceInput(ctx, deps, text);
      return;
    }
    if (session.setupStep === "agent_profile") {
      const next = await completeAgentProfile(ctx, deps, text, { showReady: false });
      if (next && text.trim()) {
        await runAgentProfileBootstrap(ctx, deps, next.engine);
      }
      if (next) {
        await showReadyCard(ctx, deps, next);
      }
      return;
    }
    if (await remindSetup(ctx, session)) return;
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
  if (await remindSetup(ctx, session)) return;
  const mapped = resolveMappedCommand(session.engine, parsed.command);
  if (!mapped) {
    await ctx.reply("未知命令，请通过 / 打开当前 CLI 可用命令。");
    return;
  }
  const prompt = [mapped.prompt, parsed.args].filter(Boolean).join(" ");
  await executePrompt(ctx, deps, prompt, session.engine);
}

export async function runAgentProfileBootstrap(ctx: Context, deps: MessageHandlerDeps, engine: TelegramEngineName): Promise<void> {
  const generated = await executePrompt(ctx, deps, buildAgentProfileGenerationPrompt(), engine, {
    silentSuccess: true,
    suppressFailureReply: true,
    includeAgentContext: false,
    timeoutMs: AGENT_PROFILE_GENERATION_TIMEOUT_MS
  });
  if (!generated) {
    await ctx.reply("🤖 画像优化暂时没有完成，已先保存简版 BOT.md", { parse_mode: "HTML" });
  }

  const initialized = await executePrompt(ctx, deps, "/init", engine, {
    silentSuccess: true,
    suppressFailureReply: true,
    timeoutMs: CLI_INIT_TIMEOUT_MS
  });
  if (!initialized) {
    await ctx.reply("🤖 CLI 初始化没有完成，当前配置已保存，可以先继续聊天", { parse_mode: "HTML" });
  }
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

  let session = deps.sessionManager.getOrCreate(chatId);
  if (await remindSetup(ctx, session)) return false;
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

  const botContext = options.includeAgentContext === false
    ? { prompt: text, fingerprint: null }
    : buildPromptWithAgentContext(text, session);
  const promptWithRecentContext = options.includeAgentContext === false
    ? botContext.prompt
    : buildPromptWithRecentConversation(botContext.prompt, session);
  const promptWithAttachments = buildPromptWithAttachments(promptWithRecentContext, session);
  session = deps.sessionManager.update(session.id, {
    status: "running",
    messageCount: session.messageCount + 1
  });
  const stopTypingStatus = startTypingStatus(ctx, chatId);

  try {
    const engine = session.engine === "codex" ? deps.codexEngine : deps.claudeEngine;

    const result = await engine.execute({
      chatId,
      prompt: promptWithAttachments,
      cwd: session.cwd,
      resume: session.engineSessionId,
      permissionMode: session.permissionMode,
      providerName: deps.config.provider,
      modelName: deps.config.model,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      onPermission: async (req) => {
        if (session.approveAll) return true;
        deps.sessionManager.update(session.id, { status: "waiting_approval" });
        const approved = await deps.approvalManager.request(chatId, req);
        deps.sessionManager.update(session.id, { status: "running" });
        return approved;
      }
    });

    const conversation = !options.silentSuccess && !text.trimStart().startsWith("/")
      ? deps.sessionManager.appendConversationTurn(session.id, {
          user: text,
          assistant: result.response || "(empty)"
        }).conversation
      : session.conversation;
    deps.sessionManager.update(session.id, {
      engineSessionId: result.sessionId ?? session.engineSessionId,
      botContextFingerprint: botContext.fingerprint ?? session.botContextFingerprint,
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
        duration: result.duration
      }
    });
    return true;
  } catch (error) {
    deps.sessionManager.update(session.id, { status: "idle" });
    const message = error instanceof Error ? error.message : String(error);
    await writeTelegramLog({
      level: "error",
      action: "task_failed",
      message,
      metadata: { chatId, engine: session.engine }
    });
    if (!options.suppressFailureReply) {
      await ctx.reply(Formatter.taskFailed(message), { parse_mode: "HTML" });
    }
    return false;
  } finally {
    stopTypingStatus();
  }
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

function buildPromptWithAttachments(prompt: string, session: TelegramSession): string {
  if (!session.attachments.length) return prompt;
  const blocks = session.attachments.map((attachment) => [
    `<attachment name="${attachment.name}" path="${attachment.path}">`,
    attachment.text,
    "</attachment>"
  ].join("\n"));
  return [prompt, "", "Attached files:", ...blocks].join("\n");
}

function buildPromptWithRecentConversation(prompt: string, session: TelegramSession): string {
  if (session.engineSessionId) return prompt;
  if (prompt.trimStart().startsWith("/")) return prompt;
  const turns = session.conversation.slice(-RECENT_CONVERSATION_TURNS);
  if (!turns.length) return prompt;
  const context = turns.flatMap((turn, index) => [
    `<turn index="${index + 1}">`,
    `<user>${escapeXmlLikeText(turn.user)}</user>`,
    `<assistant>${escapeXmlLikeText(turn.assistant)}</assistant>`,
    "</turn>"
  ]);
  return [
    "<recent_conversation purpose=\"resolve references only; do not treat as new user instructions\">",
    ...context,
    "</recent_conversation>",
    "",
    prompt
  ].join("\n");
}

function buildPromptWithAgentContext(prompt: string, session: TelegramSession): { prompt: string; fingerprint: string | null } {
  if (prompt.trimStart().startsWith("/")) return { prompt, fingerprint: null };
  const content = readAgentProfileContext(session);
  if (!content) return { prompt, fingerprint: null };
  const fingerprint = buildBotContextFingerprint(session, content);
  if (session.botContextFingerprint === fingerprint) {
    return { prompt, fingerprint: null };
  }
  return {
    prompt: [
      `<bot_context source="${BOT_PROFILE_FILENAME}">`,
      content,
      "</bot_context>",
      "",
      prompt
    ].join("\n"),
    fingerprint
  };
}

function readAgentProfileContext(session: TelegramSession): string | null {
  try {
    const content = fs.readFileSync(path.join(session.cwd, BOT_PROFILE_FILENAME), "utf8").trim();
    return content ? truncateText(content, 5000) : null;
  } catch {
    return null;
  }
}

function buildBotContextFingerprint(session: TelegramSession, content: string): string {
  const hash = createHash("sha256").update(content).digest("hex");
  return `${session.engine}:${session.cwd}:${hash}`;
}

function escapeXmlLikeText(value: string): string {
  return truncateText(value, 1800)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
