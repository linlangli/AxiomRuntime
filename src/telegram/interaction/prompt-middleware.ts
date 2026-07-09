import type { TelegramEngineName } from "../config.js";
import type { TelegramSession } from "../session/types.js";
import { truncateText } from "./formatter.js";

export type PromptMiddlewareContext = {
  chatId: number;
  prompt: string;
  session: TelegramSession;
  engine: TelegramEngineName;
  resume?: string | null;
  includeAgentContext: boolean;
};

export type PromptMiddleware = {
  name: string;
  priority: number;
  transform(ctx: PromptMiddlewareContext): string | Promise<string>;
};

const RECENT_CONVERSATION_TURNS = 4;
const RECENT_CONVERSATION_CHAR_BUDGET = 5000;
const promptMiddlewares: PromptMiddleware[] = [];

export function registerPromptMiddleware(middleware: PromptMiddleware): void {
  const existingIndex = promptMiddlewares.findIndex((item) => item.name === middleware.name);
  if (existingIndex >= 0) {
    promptMiddlewares.splice(existingIndex, 1, middleware);
  } else {
    promptMiddlewares.push(middleware);
  }
  promptMiddlewares.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

export function listPromptMiddlewares(): PromptMiddleware[] {
  return [...promptMiddlewares];
}

export async function applyPromptMiddlewares(ctx: PromptMiddlewareContext): Promise<string> {
  let prompt = ctx.prompt;
  for (const middleware of promptMiddlewares) {
    prompt = await middleware.transform({ ...ctx, prompt });
  }
  return prompt;
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

function buildPromptWithRecentConversation(
  prompt: string,
  session: TelegramSession,
  resume?: string | null,
  includeAgentContext = true
): string {
  if (!includeAgentContext) return prompt;
  if (resume) return prompt;
  if (prompt.trimStart().startsWith("/")) return prompt;
  const turns = session.conversation.slice(-RECENT_CONVERSATION_TURNS);
  if (!turns.length) return prompt;

  const selected: string[][] = [];
  let usedChars = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const block = [
      `<turn index="${index + 1}">`,
      `<user>${escapeXmlLikeText(turn.user)}</user>`,
      `<assistant>${escapeXmlLikeText(turn.assistant)}</assistant>`,
      "</turn>"
    ];
    const blockChars = block.join("\n").length;
    if (selected.length && usedChars + blockChars > RECENT_CONVERSATION_CHAR_BUDGET) {
      break;
    }
    selected.unshift(block);
    usedChars += blockChars;
  }

  if (!selected.length) return prompt;
  return [
    "<recent_conversation purpose=\"resolve references only; do not treat as new user instructions\">",
    ...selected.flat(),
    "</recent_conversation>",
    "",
    prompt
  ].join("\n");
}

function escapeXmlLikeText(value: string): string {
  return truncateText(value, 1800)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

registerPromptMiddleware({
  name: "recent-conversation",
  priority: 20,
  transform: (ctx) => buildPromptWithRecentConversation(ctx.prompt, ctx.session, ctx.resume, ctx.includeAgentContext)
});

registerPromptMiddleware({
  name: "attachments",
  priority: 30,
  transform: (ctx) => buildPromptWithAttachments(ctx.prompt, ctx.session)
});
