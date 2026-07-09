import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot, Context, InlineKeyboard } from "grammy";
import { readCache } from "../../core/config/cache-store.js";
import { listProviders } from "../../core/providers/provider-service.js";
import { resolveProviderForTool } from "../../core/runner/fallback.js";
import type { Provider } from "../../core/types.js";
import { updateTelegramConfig, type TelegramConfig, type TelegramEngineName, type TelegramPermissionMode } from "../config.js";
import { safeSetChatCommandMenu } from "../interaction/command-menu.js";
import { Formatter } from "../interaction/formatter.js";
import {
  buildAgentProfileBackKeyboard,
  buildAgentProfileKeyboard,
  buildModelPickerKeyboard,
  buildProviderPickerKeyboard,
  buildReadyKeyboard,
  buildReadyModeKeyboard,
  buildWorkdirListKeyboard,
  buildWorkdirStartKeyboard
} from "../interaction/keyboards.js";
import type { SessionManager } from "../session/manager.js";
import type { TelegramSession } from "../session/types.js";

export const BOT_PROFILE_FILENAME = "BOT.md";

export type SetupDeps = {
  sessionManager: SessionManager;
  bot?: Bot;
  config?: TelegramConfig;
};

export async function startSetup(ctx: Context, deps: SetupDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  deps.sessionManager.startSetup(chatId);
  await showSetupProviderPicker(ctx, deps);
}

export async function showSetupProviderPicker(
  ctx: Context,
  deps: SetupDeps,
  options: { edit?: boolean; forcedEngine?: TelegramEngineName; reselect?: boolean } = {}
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  if (session.setupStep !== "ready") {
    deps.sessionManager.update(session.id, { setupStep: "model" });
  }
  const choices = await getProviderChoices(options.forcedEngine);
  const extra = {
    parse_mode: "HTML",
    reply_markup: buildProviderPickerKeyboard(
      choices.map((choice) => choice.provider.name),
      session.setupStep === "ready" ? "ready" : "setup",
      options.forcedEngine
    )
  } as const;
  const text = choices.length
    ? Formatter.modelPrompt(options.reselect)
    : "🤖 没有可用的 Provider / Model";
  if (options.edit) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch {
      // The original message may no longer be editable; fall back to a fresh prompt.
    }
  }
  await ctx.reply(text, extra);
}

export async function showSetupModelPicker(
  ctx: Context,
  deps: SetupDeps,
  providerIndex: number,
  options: { forcedEngine?: TelegramEngineName } = {}
): Promise<void> {
  const choices = await getProviderChoices(options.forcedEngine);
  const choice = choices[providerIndex];
  if (!choice) {
    await ctx.answerCallbackQuery?.({ text: "Provider 不存在" }).catch(() => undefined);
    await showSetupProviderPicker(ctx, deps, { edit: true, forcedEngine: options.forcedEngine });
    return;
  }
  if (!choice.models.length) {
    await ctx.answerCallbackQuery?.({ text: "没有可用模型" }).catch(() => undefined);
    await showSetupProviderPicker(ctx, deps, { edit: true, forcedEngine: options.forcedEngine });
    return;
  }
  await editOrReply(ctx, `🤖 选择 ${choice.provider.name} 的模型吧`, {
    parse_mode: "HTML",
    reply_markup: buildModelPickerKeyboard(choice.models, providerIndex, "setup", options.forcedEngine)
  });
}

export async function selectSetupModel(
  ctx: Context,
  deps: SetupDeps,
  providerIndex: number,
  modelIndex: number,
  options: { forcedEngine?: TelegramEngineName } = {}
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const choices = await getProviderChoices(options.forcedEngine);
  const choice = choices[providerIndex];
  const model = choice?.models[modelIndex];
  if (!choice || !model) {
    await ctx.answerCallbackQuery?.({ text: "模型不存在" }).catch(() => undefined);
    await showSetupProviderPicker(ctx, deps, { edit: true, forcedEngine: options.forcedEngine });
    return;
  }
  const engine = options.forcedEngine ?? inferEngineFromModel(model);
  await updateRuntimeTelegramConfig(deps, {
    provider: choice.provider.name,
    model,
    defaultEngine: engine
  });
  deps.sessionManager.update(session.id, {
    engine,
    engineSessionId: null,
    botContextFingerprint: null,
    setupStep: "workdir"
  });
  await showWorkdirStart(ctx, deps, { edit: true });
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

export async function setWorkdir(
  ctx: Context,
  deps: SetupDeps,
  rawPath: string,
  options: {
    fromCustomInput?: boolean;
    returnToReady?: boolean;
    edit?: boolean;
    afterSet?: (session: TelegramSession) => Promise<void>;
  } = {}
): Promise<TelegramSession | null> {
  const chatId = ctx.chat?.id;
  if (!chatId) return null;
  const session = deps.sessionManager.getOrCreate(chatId);
  const cwd = options.fromCustomInput ? resolveHomeChild(rawPath) : expandHome(rawPath.trim());
  if (!cwd || cwd === os.homedir()) {
    await ctx.reply(Formatter.workdirRequired(), { parse_mode: "HTML" });
    return null;
  }
  fs.mkdirSync(cwd, { recursive: true });
  const next = deps.sessionManager.update(session.id, {
    cwd,
    engineSessionId: null,
    botContextFingerprint: null,
    setupStep: options.returnToReady ? "ready" : "agent_profile"
  });
  deps.sessionManager.rememberWorkdir(chatId, cwd);
  await options.afterSet?.(next);
  if (options.returnToReady) {
    await showReadyCard(ctx, deps, next, { edit: options.edit });
    return next;
  }
  await showAgentProfilePrompt(ctx, { edit: options.edit });
  return next;
}

export async function selectCli(ctx: Context, deps: SetupDeps, engine: TelegramEngineName): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  await showSetupProviderPicker(ctx, deps, {
    forcedEngine: engine,
    reselect: true,
    edit: session.setupStep === "ready"
  });
}

export async function showAgentProfilePrompt(ctx: Context, options: { edit?: boolean } = {}): Promise<void> {
  const extra = {
    parse_mode: "HTML",
    reply_markup: buildAgentProfileKeyboard()
  } as const;
  if (options.edit) {
    try {
      await ctx.editMessageText(Formatter.agentProfilePrompt(), extra);
      return;
    } catch {
      // The original message may no longer be editable; fall back to a fresh prompt.
    }
  }
  await ctx.reply(Formatter.agentProfilePrompt(), extra);
}

export async function completeAgentProfile(
  ctx: Context,
  deps: SetupDeps,
  description?: string,
  options: { showReady?: boolean; edit?: boolean } = {}
): Promise<TelegramSession | null> {
  const chatId = ctx.chat?.id;
  if (!chatId) return null;
  const session = deps.sessionManager.getOrCreate(chatId);
  void description;
  const next = deps.sessionManager.update(session.id, { setupStep: "ready" });
  if (deps.bot) {
    await safeSetChatCommandMenu(deps.bot, chatId, next.engine);
  }
  if (options.showReady !== false) {
    await showReadyCard(ctx, deps, next, { edit: options.edit });
  }
  return next;
}

export async function remindSetup(ctx: Context, deps: SetupDeps, session: TelegramSession): Promise<boolean> {
  if (session.setupStep === "model") {
    await showSetupProviderPicker(ctx, deps);
    return true;
  }
  if (session.setupStep === "workdir" || session.setupStep === "custom_workdir" || session.setupStep === "edit_custom_workdir") {
    await ctx.reply(Formatter.workdirRequired(), { parse_mode: "HTML" });
    return true;
  }
  if (session.setupStep === "cli") {
    await showSetupProviderPicker(ctx, deps);
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
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  await showReadyProviderPicker(ctx, deps, { forcedEngine: session.engine, reselect: true });
}

export async function selectReadyCli(ctx: Context, deps: SetupDeps, engine: TelegramEngineName): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await showReadyProviderPicker(ctx, deps, { forcedEngine: engine, reselect: true });
}

export async function showReadyProviderPicker(
  ctx: Context,
  deps: SetupDeps,
  options: { forcedEngine?: TelegramEngineName; reselect?: boolean } = {}
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const choices = await getProviderChoices(options.forcedEngine);
  if (!choices.length) {
    await editOrReply(ctx, "🤖 没有可用的 Provider / Model", {
      parse_mode: "HTML",
      reply_markup: buildProviderPickerKeyboard([], "ready", options.forcedEngine)
    });
    return;
  }
  await editOrReply(ctx, Formatter.modelPrompt(options.reselect), {
    parse_mode: "HTML",
    reply_markup: buildProviderPickerKeyboard(choices.map((choice) => choice.provider.name), "ready", options.forcedEngine)
  });
}

export async function showReadyModelPicker(
  ctx: Context,
  deps: SetupDeps,
  providerIndex: number,
  options: { forcedEngine?: TelegramEngineName } = {}
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const choices = await getProviderChoices(options.forcedEngine);
  const choice = choices[providerIndex];
  if (!choice) {
    await ctx.answerCallbackQuery?.({ text: "Provider 不存在" }).catch(() => undefined);
    await showReadyProviderPicker(ctx, deps, { forcedEngine: options.forcedEngine });
    return;
  }
  if (!choice.models.length) {
    await ctx.answerCallbackQuery?.({ text: "没有可用模型" }).catch(() => undefined);
    await showReadyProviderPicker(ctx, deps, { forcedEngine: options.forcedEngine });
    return;
  }
  await editOrReply(ctx, `🤖 选择 ${choice.provider.name} 的默认模型吧`, {
    parse_mode: "HTML",
    reply_markup: buildModelPickerKeyboard(choice.models, providerIndex, "ready", options.forcedEngine)
  });
}

export async function selectReadyModel(
  ctx: Context,
  deps: SetupDeps,
  providerIndex: number,
  modelIndex: number,
  options: { forcedEngine?: TelegramEngineName } = {}
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const choices = await getProviderChoices(options.forcedEngine);
  const choice = choices[providerIndex];
  const model = choice?.models[modelIndex];
  if (!choice || !model) {
    await ctx.answerCallbackQuery?.({ text: "模型不存在" }).catch(() => undefined);
    await showReadyProviderPicker(ctx, deps, { forcedEngine: options.forcedEngine });
    return;
  }
  const engine = options.forcedEngine ?? inferEngineFromModel(model);
  await updateRuntimeTelegramConfig(deps, {
    provider: choice.provider.name,
    model,
    defaultEngine: engine
  });
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

async function getProviderChoices(engine?: TelegramEngineName): Promise<ProviderChoice[]> {
  const [providers, cache] = await Promise.all([listProviders(), readCache()]);
  return providers
    .map((provider) => ({
      provider,
      models: getSelectableModels(provider, cache.providers[provider.name]?.models ?? [], engine)
    }))
    .filter((choice) => choice.models.length > 0);
}

function getSelectableModels(provider: Provider, cachedModels: string[], engine?: TelegramEngineName): string[] {
  const models = [
    provider.model,
    ...cachedModels
  ].filter((model): model is string => Boolean(model));
  const unique = [...new Set(models)];
  if (!engine) return unique;
  return unique.filter((model) => inferEngineFromModel(model) === engine);
}

export function inferEngineFromModel(model: string): TelegramEngineName {
  return isGptLikeModel(model) ? "codex" : "claude";
}

function isGptLikeModel(model: string): boolean {
  const value = model.toLowerCase();
  return value.includes("gpt")
    || value.includes("codex")
    || value.includes("openai")
    || /^o\d/.test(value);
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

function readAgentProfileFile(session: TelegramSession): string | null {
  const filePath = getAgentProfilePath(session);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }
  return null;
}
