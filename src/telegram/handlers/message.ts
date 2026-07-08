import { InputFile, type Bot, type Context } from "grammy";
import type { TelegramConfig, TelegramEngineName } from "../config.js";
import type { Engine, ExecutionResult } from "../engine/types.js";
import type { ApprovalManager } from "../interaction/approval.js";
import { parseTelegramCommand, resolveMappedCommand } from "../interaction/command-menu.js";
import { Formatter } from "../interaction/formatter.js";
import type { SessionManager, TelegramSession } from "../session/manager.js";
import { writeTelegramLog } from "../log.js";
import { remindSetup, setWorkdir } from "./setup.js";

export type MessageHandlerDeps = {
  sessionManager: SessionManager;
  claudeEngine: Engine;
  codexEngine: Engine;
  approvalManager: ApprovalManager;
  config: TelegramConfig;
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

export async function executePrompt(
  ctx: Context,
  deps: MessageHandlerDeps,
  prompt: string,
  forcedEngine?: TelegramEngineName
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const text = prompt.trim();
  if (!text) {
    await ctx.reply("Prompt is empty.");
    return;
  }

  let session = deps.sessionManager.getOrCreate(chatId);
  if (await remindSetup(ctx, session)) return;
  if (forcedEngine && session.engine !== forcedEngine) {
    session = deps.sessionManager.update(session.id, { engine: forcedEngine });
  }

  if (session.status === "running" || session.status === "waiting_approval") {
    await ctx.reply("已有任务正在运行，请等待完成。");
    return;
  }

  const promptWithAttachments = buildPromptWithAttachments(text, session);
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
      onPermission: async (req) => {
        if (session.approveAll) return true;
        deps.sessionManager.update(session.id, { status: "waiting_approval" });
        const approved = await deps.approvalManager.request(chatId, req);
        deps.sessionManager.update(session.id, { status: "running" });
        return approved;
      }
    });

    deps.sessionManager.update(session.id, {
      engineSessionId: result.sessionId ?? session.engineSessionId,
      status: "idle",
      attachments: []
    });
    deps.sessionManager.recordProviderUsage(session.id, {
      provider: result.provider ?? deps.config.provider ?? "unknown",
      model: result.model ?? deps.config.model,
      costUsd: result.cost
    });
    await sendResult(ctx, session.engine, result, deps.config.maxOutputLength);
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
  } catch (error) {
    deps.sessionManager.update(session.id, { status: "idle" });
    const message = error instanceof Error ? error.message : String(error);
    await writeTelegramLog({
      level: "error",
      action: "task_failed",
      message,
      metadata: { chatId, engine: session.engine }
    });
    await ctx.reply(Formatter.taskFailed(message), { parse_mode: "HTML" });
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
    await ctx.reply(formatted, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(
    Formatter.taskCompleted(engine, { ...result, response: "Output is attached as a file." }, 800),
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

function buildPromptWithAttachments(prompt: string, session: TelegramSession): string {
  if (!session.attachments.length) return prompt;
  const blocks = session.attachments.map((attachment) => [
    `<attachment name="${attachment.name}" path="${attachment.path}">`,
    attachment.text,
    "</attachment>"
  ].join("\n"));
  return [prompt, "", "Attached files:", ...blocks].join("\n");
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
