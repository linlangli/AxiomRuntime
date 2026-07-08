import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot, Context, InlineKeyboard } from "grammy";
import { readCache } from "../../core/config/cache-store.js";
import { isModelCompatible } from "../../core/models/model-filter.js";
import { listProviders } from "../../core/providers/provider-service.js";
import { resolveProviderForTool } from "../../core/runner/fallback.js";
import type { Provider } from "../../core/types.js";
import { updateTelegramConfig, type TelegramConfig, type TelegramEngineName, type TelegramPermissionMode } from "../config.js";
import { safeSetChatCommandMenu } from "../interaction/command-menu.js";
import { Formatter } from "../interaction/formatter.js";
import {
  buildAgentProfileBackKeyboard,
  buildAgentProfileKeyboard,
  buildCliKeyboard,
  buildReadyCliKeyboard,
  buildReadyKeyboard,
  buildReadyModeKeyboard,
  buildReadyModelKeyboard,
  buildReadyProviderKeyboard,
  buildWorkdirListKeyboard,
  buildWorkdirStartKeyboard
} from "../interaction/keyboards.js";
import type { SessionManager } from "../session/manager.js";
import type { TelegramSession } from "../session/types.js";

export const BOT_PROFILE_FILENAME = "BOT.md";
export const PROMPT_PROFILE_FILENAME = "PROMPT.md";

export type SetupDeps = {
  sessionManager: SessionManager;
  bot?: Bot;
  config?: TelegramConfig;
};

export async function startSetup(ctx: Context, deps: SetupDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  deps.sessionManager.startSetup(chatId);
  await showWorkdirStart(ctx, deps);
}

export async function showWorkdirStart(ctx: Context, deps: SetupDeps, options: { edit?: boolean; scope?: "setup" | "ready" } = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const workdirs = deps.sessionManager.getWorkdirs(chatId);
  const extra = {
    parse_mode: "HTML",
    reply_markup: buildWorkdirStartKeyboard(workdirs.length > 0, options.scope ?? "setup")
  } as const;
  if (options.edit) {
    try {
      await ctx.editMessageText(Formatter.workdirPrompt(), extra);
      return;
    } catch {
      // The original message may no longer be editable; fall back to a fresh prompt.
    }
  }
  await ctx.reply(Formatter.workdirPrompt(), extra);
}

export async function showWorkdirList(ctx: Context, deps: SetupDeps, options: { edit?: boolean; scope?: "setup" | "ready" } = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const workdirs = deps.sessionManager.getWorkdirs(chatId);
  const extra = {
    parse_mode: "HTML",
    reply_markup: buildWorkdirListKeyboard(workdirs, options.scope ?? "setup")
  } as const;
  if (options.edit) {
    try {
      await ctx.editMessageText(Formatter.workdirList(workdirs), extra);
      return;
    } catch {
      // The original message may no longer be editable; fall back to a fresh prompt.
    }
  }
  await ctx.reply(Formatter.workdirList(workdirs), extra);
}

export async function askCustomWorkdir(ctx: Context, deps: SetupDeps, options: { edit?: boolean; returnToReady?: boolean } = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  deps.sessionManager.update(session.id, { setupStep: options.returnToReady ? "edit_custom_workdir" : "custom_workdir" });
  const extra = { parse_mode: "HTML" } as const;
  if (options.edit) {
    try {
      await ctx.editMessageText(Formatter.customWorkdirPrompt(), extra);
      return;
    } catch {
      // The original message may no longer be editable; fall back to a fresh prompt.
    }
  }
  await ctx.reply(Formatter.customWorkdirPrompt(), extra);
}

export async function setWorkdir(ctx: Context, deps: SetupDeps, rawPath: string, options: { fromCustomInput?: boolean; returnToReady?: boolean; edit?: boolean } = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const cwd = options.fromCustomInput ? resolveHomeChild(rawPath) : expandHome(rawPath.trim());
  if (!cwd || cwd === os.homedir()) {
    await ctx.reply(Formatter.workdirRequired(), { parse_mode: "HTML" });
    return;
  }
  fs.mkdirSync(cwd, { recursive: true });
  const next = deps.sessionManager.update(session.id, {
    cwd,
    engineSessionId: null,
    botContextFingerprint: null,
    setupStep: options.returnToReady ? "ready" : "cli"
  });
  deps.sessionManager.rememberWorkdir(chatId, cwd);
  if (options.returnToReady) {
    await showReadyCard(ctx, deps, next, { edit: options.edit });
    return;
  }
  await ctx.reply(Formatter.cliPrompt(next.cwd), {
    parse_mode: "HTML",
    reply_markup: buildCliKeyboard()
  });
}

export async function selectCli(ctx: Context, deps: SetupDeps, engine: TelegramEngineName): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  if (session.setupStep === "workdir" || session.setupStep === "custom_workdir") {
    await ctx.reply(Formatter.workdirRequired(), { parse_mode: "HTML" });
    return;
  }
  const next = deps.sessionManager.update(session.id, {
    engine,
    engineSessionId: null,
    botContextFingerprint: null,
    setupStep: "agent_profile"
  });
  deps.sessionManager.rememberWorkdir(chatId, next.cwd);
  if (deps.bot) {
    await safeSetChatCommandMenu(deps.bot, chatId, engine);
  }
  await showAgentProfilePrompt(ctx);
}

export async function showAgentProfilePrompt(ctx: Context): Promise<void> {
  await ctx.reply(Formatter.agentProfilePrompt(), {
    parse_mode: "HTML",
    reply_markup: buildAgentProfileKeyboard()
  });
}

export async function completeAgentProfile(
  ctx: Context,
  deps: SetupDeps,
  description?: string,
  options: { showReady?: boolean } = {}
): Promise<TelegramSession | null> {
  const chatId = ctx.chat?.id;
  if (!chatId) return null;
  const session = deps.sessionManager.getOrCreate(chatId);
  if (description?.trim()) {
    writePromptProfileFile(session, description);
    writeBotProfileFallbackFile(session, description);
  }
  const next = deps.sessionManager.update(session.id, { setupStep: "ready" });
  if (options.showReady !== false) {
    await showReadyCard(ctx, deps, next);
  }
  return next;
}

export async function remindSetup(ctx: Context, session: TelegramSession): Promise<boolean> {
  if (session.setupStep === "workdir" || session.setupStep === "custom_workdir" || session.setupStep === "edit_custom_workdir") {
    await ctx.reply(Formatter.workdirRequired(), { parse_mode: "HTML" });
    return true;
  }
  if (session.setupStep === "cli") {
    await ctx.reply(Formatter.cliRequired(), {
      parse_mode: "HTML",
      reply_markup: buildCliKeyboard()
    });
    return true;
  }
  if (session.setupStep === "agent_profile") {
    await ctx.reply(Formatter.agentProfilePrompt(), {
      parse_mode: "HTML",
      reply_markup: buildAgentProfileKeyboard()
    });
    return true;
  }
  return false;
}

export async function showReadyCard(ctx: Context, deps: SetupDeps, session: TelegramSession, options: { edit?: boolean } = {}): Promise<void> {
  const resolved = await getResolvedProvider(session.engine, deps.config);
  const extra = buildConfigExtra(session, resolved.provider);
  if (options.edit) {
    try {
      await ctx.editMessageText(Formatter.sessionCard(session, resolved.provider, resolved.error), extra);
      return;
    } catch {
      // The original message may no longer be editable; fall back to a fresh card.
    }
  }
  await ctx.reply(Formatter.sessionCard(session, resolved.provider, resolved.error), extra);
}

export async function showConfigPanel(ctx: Context, deps: SetupDeps, session: TelegramSession, options: { edit?: boolean } = {}): Promise<void> {
  const resolved = await getResolvedProvider(session.engine, deps.config);
  const extra = buildConfigExtra(session, resolved.provider);
  if (options.edit) {
    try {
      await ctx.editMessageText(Formatter.configPanel(), extra);
      return;
    } catch {
      // The original message may no longer be editable; fall back to a fresh panel.
    }
  }
  await ctx.reply(Formatter.configPanel(), extra);
}

export async function showAgentProfile(ctx: Context, deps: SetupDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const content = readAgentProfileFile(session) ?? "暂未生成 BOT.md。";
  await editOrReply(ctx, Formatter.agentProfile(content), {
    parse_mode: "HTML",
    reply_markup: buildAgentProfileBackKeyboard()
  });
}

export async function showReadyCliPicker(ctx: Context, deps: SetupDeps): Promise<void> {
  await editOrReply(ctx, "🤖 确定你要使用的CLI吧", {
    parse_mode: "HTML",
    reply_markup: buildReadyCliKeyboard()
  });
}

export async function selectReadyCli(ctx: Context, deps: SetupDeps, engine: TelegramEngineName): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const next = deps.sessionManager.update(session.id, {
    engine,
    engineSessionId: null,
    botContextFingerprint: null,
    setupStep: "ready"
  });
  if (deps.bot) {
    await safeSetChatCommandMenu(deps.bot, chatId, engine);
  }
  await showReadyCard(ctx, deps, next, { edit: true });
}

export async function showReadyProviderPicker(ctx: Context, deps: SetupDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const choices = await getProviderChoices(session.engine);
  if (!choices.length) {
    await editOrReply(ctx, "🤖 没有可用的 Provider / Model", {
      parse_mode: "HTML",
      reply_markup: buildReadyProviderKeyboard([])
    });
    return;
  }
  await editOrReply(ctx, "🤖 选择 Provider 吧", {
    parse_mode: "HTML",
    reply_markup: buildReadyProviderKeyboard(choices.map((choice) => choice.provider.name))
  });
}

export async function showReadyModelPicker(ctx: Context, deps: SetupDeps, providerIndex: number): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const choices = await getProviderChoices(session.engine);
  const choice = choices[providerIndex];
  if (!choice) {
    await ctx.answerCallbackQuery?.({ text: "Provider 不存在" }).catch(() => undefined);
    await showReadyProviderPicker(ctx, deps);
    return;
  }
  if (!choice.models.length) {
    await ctx.answerCallbackQuery?.({ text: "没有可用模型" }).catch(() => undefined);
    await showReadyProviderPicker(ctx, deps);
    return;
  }
  await editOrReply(ctx, `🤖 选择 ${choice.provider.name} 的默认模型吧`, {
    parse_mode: "HTML",
    reply_markup: buildReadyModelKeyboard(choice.models, providerIndex)
  });
}

export async function selectReadyModel(ctx: Context, deps: SetupDeps, providerIndex: number, modelIndex: number): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const choices = await getProviderChoices(session.engine);
  const choice = choices[providerIndex];
  const model = choice?.models[modelIndex];
  if (!choice || !model) {
    await ctx.answerCallbackQuery?.({ text: "模型不存在" }).catch(() => undefined);
    await showReadyProviderPicker(ctx, deps);
    return;
  }
  await updateRuntimeTelegramConfig(deps, { provider: choice.provider.name, model });
  deps.sessionManager.update(session.id, {
    engineSessionId: null,
    botContextFingerprint: null
  });
  await showReadyCard(ctx, deps, deps.sessionManager.getOrCreate(chatId), { edit: true });
}

export async function showReadyModePicker(ctx: Context): Promise<void> {
  await editOrReply(ctx, "🤖 选择权限模式吧", {
    parse_mode: "HTML",
    reply_markup: buildReadyModeKeyboard()
  });
}

export async function selectReadyMode(ctx: Context, deps: SetupDeps, mode: TelegramPermissionMode): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const next = deps.sessionManager.update(session.id, { permissionMode: mode, setupStep: "ready" });
  await updateRuntimeTelegramConfig(deps, { defaultPermissionMode: mode });
  await showReadyCard(ctx, deps, next, { edit: true });
}

async function getResolvedProvider(engine: TelegramEngineName, config?: TelegramConfig): Promise<{ provider?: { name: string; model: string }; error?: string }> {
  try {
    const resolved = await resolveProviderForTool(engine, config?.provider, config?.model);
    return { provider: { name: resolved.provider.name, model: resolved.model } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function buildConfigExtra(session: TelegramSession, provider?: { name: string; model: string }) {
  const providerModel = provider
    ? `${provider.name} · ${provider.model}`
    : "配置 Provider / Model";
  return {
    parse_mode: "HTML",
    reply_markup: buildReadyKeyboard({
      cli: session.engine === "claude" ? "Claude Code" : "Codex",
      providerModel,
      permissionMode: session.permissionMode,
      cwd: session.cwd
    })
  } as const;
}

type ProviderChoice = {
  provider: Provider;
  models: string[];
};

async function getProviderChoices(engine: TelegramEngineName): Promise<ProviderChoice[]> {
  const [providers, cache] = await Promise.all([listProviders(), readCache()]);
  return providers
    .map((provider) => ({
      provider,
      models: getCompatibleModels(engine, provider, cache.providers[provider.name]?.models ?? [])
    }))
    .filter((choice) => choice.models.length > 0);
}

function getCompatibleModels(engine: TelegramEngineName, provider: Provider, cachedModels: string[]): string[] {
  const models = [
    provider.model,
    ...cachedModels
  ].filter((model): model is string => Boolean(model && isModelCompatible(engine, model)));
  return [...new Set(models)];
}

async function updateRuntimeTelegramConfig(deps: SetupDeps, patch: Partial<TelegramConfig>): Promise<void> {
  const updated = await updateTelegramConfig(patch);
  if (deps.config) {
    Object.assign(deps.config, updated);
  }
}

type InlineHtmlOptions = {
  parse_mode: "HTML";
  reply_markup?: InlineKeyboard;
};

async function editOrReply(ctx: Context, text: string, extra: InlineHtmlOptions): Promise<void> {
  try {
    await ctx.editMessageText(text, extra);
    return;
  } catch {
    // The original message may no longer be editable; fall back to a fresh message.
  }
  await ctx.reply(text, extra);
}

function resolveHomeChild(value: string): string {
  const name = value.trim().replace(/^~\//, "").replace(/^\/+/, "");
  return path.join(os.homedir(), name);
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function getAgentProfilePath(session: TelegramSession): string {
  return path.join(session.cwd, BOT_PROFILE_FILENAME);
}

export function getPromptProfilePath(session: TelegramSession): string {
  return path.join(session.cwd, PROMPT_PROFILE_FILENAME);
}

export function buildAgentProfileGenerationPrompt(): string {
  return [
    "请读取当前工作目录下的 PROMPT.md，并根据其中用户的完整原始表述，生成一份精炼的 Telegram Bot 画像文件 BOT.md。",
    "",
    "要求：",
    "- 必须创建或覆盖当前工作目录下的 BOT.md。",
    "- 不要修改 PROMPT.md，也不要修改其它文件。",
    "- BOT.md 是后续每次 Telegram 对话都会注入的上下文，所以必须简洁、稳定、可执行。",
    "- 保留长期有效的信息：机器人身份、用户偏好、分析框架、输出风格、风险边界、数据偏好、禁止事项。",
    "- 删除临时寒暄、重复内容、上传说明、会话 id、provider/model、实现细节。",
    "- 中文输入就使用中文。",
    "- 总长度控制在 1200 个中文字符以内。",
    "",
    "建议结构：",
    "# BOT",
    "## 角色与目标",
    "## 用户偏好",
    "## 工作方式",
    "## 风险边界",
    "",
    "完成后只需要简短说明已写入 BOT.md。"
  ].join("\n");
}

function readAgentProfileFile(session: TelegramSession): string | null {
  const filePath = getAgentProfilePath(session);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }
  return null;
}

function writePromptProfileFile(session: TelegramSession, description: string): string {
  fs.mkdirSync(session.cwd, { recursive: true });
  const content = `${description.trim()}\n`;
  fs.writeFileSync(getPromptProfilePath(session), content);
  return content;
}

function writeBotProfileFallbackFile(session: TelegramSession, description: string): string {
  fs.mkdirSync(session.cwd, { recursive: true });
  const excerpt = normalizeProfileDescription(description).slice(0, 1000);
  const content = [
    "# BOT",
    "",
    "## 角色与目标",
    "根据用户提供的长期描述，在 Telegram 对话中保持一致的助手画像。",
    "",
    "## 用户偏好",
    excerpt,
    "",
    "## 工作方式",
    "回复保持简洁、直接、可执行。优先使用中文，先给结论，再说明关键依据和风险。",
    "",
    "## 风险边界",
    "涉及投资、医疗、法律等高风险内容时说明不确定性，不替用户做最终决策。"
  ].join("\n");
  fs.writeFileSync(getAgentProfilePath(session), `${content.trim()}\n`);
  return content;
}

function normalizeProfileDescription(value: string): string {
  return value
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}
