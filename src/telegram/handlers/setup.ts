import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { readCache } from "../../core/config/cache-store.js";
import { expandHomePath } from "../../core/config/paths.js";
import { readCodexChatGptModels, type CodexChatGptModel } from "../../core/integrations/codex-provider-config.js";
import { listProviders } from "../../core/providers/provider-service.js";
import { resolveProviderForTool } from "../../core/runner/fallback.js";
import type { Provider } from "../../core/types.js";
import { updateTelegramConfig, usesTelegramCodexChatGpt, type TelegramConfig, type TelegramEngineName, type TelegramPermissionMode } from "../config.js";
import type { TelegramEngineMap } from "../engine/registry.js";
import type { Engine } from "../engine/types.js";
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
import {
  buildFullProfilePrompt,
  buildPersonaPrompt,
  type MemoryService,
  splitProfileAndPersona
} from "../memory/memory-service.js";
import type { SessionManager } from "../session/manager.js";
import type { TelegramSession } from "../session/types.js";

export const AGENT_PROFILE_GENERATION_TIMEOUT_MS = 3 * 60 * 1000;

export type SetupDeps = {
  sessionManager: SessionManager;
  bot?: Bot;
  config?: TelegramConfig;
  claudeEngine?: Engine;
  codexEngine?: Engine;
  engines?: Partial<TelegramEngineMap>;
  memoryService?: MemoryService;
  initializeWorkdir?: (ctx: Context, engine: TelegramEngineName, options: { edit?: boolean }) => Promise<void>;
  updateConfig?: (patch: Partial<TelegramConfig>) => Promise<TelegramConfig>;
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
  if (usesTelegramCodexChatGpt(options.forcedEngine ?? session.engine, deps.config)) {
    await selectChatGptCodex(ctx, deps, session, { edit: options.edit });
    return;
  }
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
  await continueWorkdirSetup(ctx, deps, { edit: true });
}

async function continueWorkdirSetup(ctx: Context, deps: SetupDeps, options: { edit?: boolean }): Promise<void> {
  const cwd = deps.sessionManager.getDefaultWorkdir();
  if (!cwd) {
    await showWorkdirStart(ctx, deps, options);
    return;
  }
  await setWorkdir(ctx, deps, cwd, {
    ...options,
    afterSet: async ({ engine }) => {
      await deps.initializeWorkdir?.(ctx, engine, options);
    }
  });
}

export async function showWorkdirStart(ctx: Context, deps: SetupDeps, options: { edit?: boolean; scope?: "setup" | "ready"; prompt?: string } = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const workdirs = deps.sessionManager.getWorkdirs(chatId);
  const defaultCwd = deps.sessionManager.getDefaultWorkdir();
  const text = options.prompt ?? Formatter.workdirList(workdirs, defaultCwd);
  const extra = {
    parse_mode: "HTML",
    reply_markup: buildWorkdirStartKeyboard(workdirs, options.scope ?? "setup", defaultCwd)
  } as const;
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

export async function showWorkdirList(ctx: Context, deps: SetupDeps, options: { edit?: boolean; scope?: "setup" | "ready" } = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const workdirs = deps.sessionManager.getWorkdirs(chatId);
  const defaultCwd = deps.sessionManager.getDefaultWorkdir();
  const text = Formatter.workdirList(workdirs, defaultCwd);
  const extra = { parse_mode: "HTML", reply_markup: buildWorkdirListKeyboard(workdirs, options.scope ?? "setup", defaultCwd) } as const;
  if (options.edit) await editOrReply(ctx, text, extra);
  else await ctx.reply(text, extra);
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
  const cwd = options.fromCustomInput ? resolveHomeChild(rawPath) : expandHomePath(rawPath.trim());
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
  if (deps.bot) {
    const customCommands = deps.sessionManager.listCustomCommands(chatId, cwd);
    await safeSetChatCommandMenu(deps.bot, chatId, next.engine, customCommands);
  }
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
  const rawDescription = description?.trim();
  if (rawDescription && deps.memoryService) {
    await saveGeneratedProfileMemory(ctx, deps, session, rawDescription);
  }
  const next = deps.sessionManager.update(session.id, { setupStep: "ready" });
  if (deps.bot) {
    const customCommands = deps.sessionManager.listCustomCommands(chatId, next.cwd);
    await safeSetChatCommandMenu(deps.bot, chatId, next.engine, customCommands);
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
  const content = deps.memoryService
    ? formatProfileMemory(deps.memoryService, chatId)
    : "暂未启用 Bot Memory。";
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

export async function showTelegramModelPicker(ctx: Context, deps: SetupDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  if (usesTelegramCodexChatGpt(session.engine, deps.config)) {
    await showChatGptModelPicker(ctx, deps, session, false);
  } else if (session.setupStep === "ready") {
    await showReadyProviderPicker(ctx, deps, { reselect: true });
  } else {
    await showSetupProviderPicker(ctx, deps, { reselect: true });
  }
}

async function showChatGptModelPicker(ctx: Context, deps: SetupDeps, session: TelegramSession, edit: boolean): Promise<void> {
  const models = await readCodexChatGptModels();
  const current = deps.config?.codexModel;
  const keyboard = new InlineKeyboard()
    .text(current ? "跟随 Codex 默认模型" : "✓ 跟随 Codex 默认模型", "chatgpt-model:default").row();
  for (const { slug } of models.slice(0, 98)) {
    const effort = deps.config?.codexReasoningEffort;
    const label = slug === current ? `✓ ${slug}${effort ? ` · ${effort}` : ""}` : slug;
    keyboard.text(label, `chatgpt-model:${chatGptModelKey(slug)}`).row();
  }
  if (session.setupStep === "ready") keyboard.text("返回", "ready:back");
  const text = models.length
    ? "选择 ChatGPT 模型和推理档位。"
    : "本机暂无 Codex 模型列表。请打开已登录的 Codex 刷新列表，再发送 /model。";
  const extra = { parse_mode: "HTML", reply_markup: keyboard } as const;
  if (edit) await editOrReply(ctx, text, extra);
  else await ctx.reply(text, extra);
}

export async function selectChatGptModel(ctx: Context, deps: SetupDeps, key: string, effort?: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  if (!usesTelegramCodexChatGpt(session.engine, deps.config)) {
    await ctx.answerCallbackQuery({ text: "请先切换到使用 ChatGPT 登录的 Codex。" });
    return;
  }

  if (key === "back") {
    await ctx.answerCallbackQuery();
    await showChatGptModelPicker(ctx, deps, session, true);
    return;
  }

  let selected: CodexChatGptModel | undefined;
  if (key !== "default") {
    selected = (await readCodexChatGptModels()).find(model => chatGptModelKey(model.slug) === key);
    if (!selected) {
      await ctx.answerCallbackQuery({ text: "此模型已从列表移除，请重新选择。" });
      await showChatGptModelPicker(ctx, deps, session, true);
      return;
    }
    if (effort === undefined && selected.reasoningEfforts.length) {
      await ctx.answerCallbackQuery();
      await showChatGptEffortPicker(ctx, deps, selected, key);
      return;
    }
    if (effort && effort !== "default" && !selected.reasoningEfforts.includes(effort)) {
      await ctx.answerCallbackQuery({ text: "此模型已不支持该档位，请重新选择。" });
      await showChatGptEffortPicker(ctx, deps, selected, key);
      return;
    }
  }
  await updateRuntimeTelegramConfig(deps, {
    codexModel: selected?.slug,
    codexReasoningEffort: selected && effort !== "default" ? effort : undefined
  });
  await ctx.answerCallbackQuery({ text: "ChatGPT 设置已更新" });
  await showChatGptModelPicker(ctx, deps, session, true);
}

async function showChatGptEffortPicker(ctx: Context, deps: SetupDeps, model: CodexChatGptModel, key: string): Promise<void> {
  const current = model.slug === deps.config?.codexModel ? deps.config?.codexReasoningEffort : undefined;
  const keyboard = new InlineKeyboard()
    .text(current ? "跟随 Codex 设置" : "✓ 跟随 Codex 设置", `cg-effort:${key}:default`).row();
  for (const effort of model.reasoningEfforts) {
    const callback = `cg-effort:${key}:${effort}`;
    if (callback.length <= 64) keyboard.text(effort === current ? `✓ ${effort}` : effort, callback).row();
  }
  keyboard.text("返回模型列表", "chatgpt-model:back");
  await editOrReply(ctx, `选择 ${model.slug} 的推理档位`, { parse_mode: "HTML", reply_markup: keyboard });
}

function chatGptModelKey(model: string): string {
  return createHash("sha256").update(model).digest("base64url");
}

export async function showReadyProviderPicker(
  ctx: Context,
  deps: SetupDeps,
  options: { forcedEngine?: TelegramEngineName; reselect?: boolean } = {}
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  if (usesTelegramCodexChatGpt(options.forcedEngine ?? session.engine, deps.config)) {
    if (options.forcedEngine) await selectChatGptCodex(ctx, deps, session, { edit: true });
    else await showChatGptModelPicker(ctx, deps, session, true);
    return;
  }
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
    const customCommands = deps.sessionManager.listCustomCommands(chatId, next.cwd);
    await safeSetChatCommandMenu(deps.bot, chatId, engine, customCommands);
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
  if (usesTelegramCodexChatGpt(engine, config)) {
    const model = config?.codexModel ?? "Codex 默认模型";
    const effort = config?.codexReasoningEffort;
    return { provider: { name: "ChatGPT", model: effort ? `${model} · ${effort}` : model } };
  }
  try {
    const resolved = await resolveProviderForTool(engine, config?.provider, config?.model);
    return { provider: { name: resolved.provider.name, model: resolved.model } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function selectChatGptCodex(ctx: Context, deps: SetupDeps, session: TelegramSession, options: { edit?: boolean }): Promise<void> {
  if (deps.config?.defaultEngine !== "codex") await updateRuntimeTelegramConfig(deps, { defaultEngine: "codex" });
  const next = deps.sessionManager.update(session.id, {
    ...(session.engine !== "codex" ? { engine: "codex", engineSessionId: null, botContextFingerprint: null } : {}),
    setupStep: session.setupStep === "ready" ? "ready" : "workdir"
  });
  if (next.setupStep === "workdir") {
    await continueWorkdirSetup(ctx, deps, options);
  } else {
    if (deps.bot && session.engine !== "codex") {
      await safeSetChatCommandMenu(deps.bot, next.chatId, next.engine, deps.sessionManager.listCustomCommands(next.chatId, next.cwd));
    }
    await showReadyCard(ctx, deps, next, options);
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
  const updated = deps.updateConfig
    ? await deps.updateConfig(patch)
    : await updateTelegramConfig(patch);
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

async function saveGeneratedProfileMemory(
  ctx: Context,
  deps: SetupDeps,
  session: TelegramSession,
  rawDescription: string
): Promise<void> {
  const memoryService = deps.memoryService;
  if (!memoryService) return;
  memoryService.saveRawDescription(session.chatId, rawDescription);
  const existingProfile = memoryService.getProfile(session.chatId);
  if (existingProfile) {
    const prompt = buildPersonaPrompt(rawDescription, existingProfile.content);
    const generated = await generateProfileText(ctx, deps, session, prompt);
    memoryService.savePersona(session.chatId, generated || rawDescription);
    return;
  }

  const prompt = buildFullProfilePrompt(rawDescription);
  const generated = await generateProfileText(ctx, deps, session, prompt);
  if (!generated) {
    memoryService.saveProfile(session.chatId, rawDescription);
    return;
  }
  const { profile, persona } = splitProfileAndPersona(generated);
  memoryService.saveProfile(session.chatId, profile || rawDescription);
  if (persona) {
    memoryService.savePersona(session.chatId, persona);
  }
}

async function generateProfileText(
  ctx: Context,
  deps: SetupDeps,
  session: TelegramSession,
  prompt: string
): Promise<string | null> {
  const engine = resolveSetupEngine(deps, session.engine);
  if (!engine) return null;
  const codexChatGpt = usesTelegramCodexChatGpt(session.engine, deps.config);
  try {
    const result = await engine.execute({
      chatId: ctx.chat?.id ?? session.chatId,
      prompt,
      cwd: session.cwd,
      resume: null,
      permissionMode: session.permissionMode,
      providerName: codexChatGpt ? undefined : deps.config?.provider,
      modelName: codexChatGpt ? deps.config?.codexModel : deps.config?.model,
      ...(codexChatGpt ? {
        codexChatGpt: { proxyUrl: deps.config?.proxyUrl, reasoningEffort: deps.config?.codexReasoningEffort }
      } : {}),
      timeoutMs: AGENT_PROFILE_GENERATION_TIMEOUT_MS,
      onPermission: async () => true
    });
    return result.response.trim() || null;
  } catch {
    return null;
  }
}

function resolveSetupEngine(deps: SetupDeps, engine: TelegramEngineName): Engine | undefined {
  if (deps.engines?.[engine]) return deps.engines[engine];
  return engine === "codex" ? deps.codexEngine : deps.claudeEngine;
}

function formatProfileMemory(memoryService: MemoryService, chatId: number): string {
  const profile = memoryService.getProfile(chatId);
  const persona = memoryService.getPersona(chatId);
  if (!profile && !persona) return "暂未生成记忆画像。";
  return [
    profile ? ["# 用户画像", "", profile.content].join("\n") : "",
    persona ? ["# Bot 人设", "", persona.content].join("\n") : ""
  ].filter(Boolean).join("\n\n");
}

function resolveHomeChild(value: string): string {
  const name = value.trim().replace(/^~\//, "").replace(/^\/+/, "");
  return path.join(os.homedir(), name);
}
