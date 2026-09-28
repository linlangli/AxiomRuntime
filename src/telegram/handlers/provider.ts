import { createHash } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";
import {
  addProvider,
  deleteProvider,
  getCachedModels,
  getProviderPriorityOptions,
  listProviders,
  updateProvider
} from "../../core/providers/provider-service.js";
import type { AddProviderInput } from "../../core/providers/provider-service.js";
import type { Provider, ProviderMode } from "../../core/types.js";
import { describeProviderRequestProfile } from "../../core/providers/provider-request-profile.js";
import { escapeHtml, truncateText } from "../interaction/formatter.js";

type EditableProviderField = "name" | "baseUrl" | "apiKey" | "model";

type AddProviderDraft = {
  kind: "add";
  step: "name" | "baseUrl" | "apiKey" | "level";
  values: Partial<AddProviderInput>;
};

type EditProviderDraft = {
  kind: "edit";
  providerName: string;
  field: EditableProviderField;
};

type ProviderDraft = AddProviderDraft | EditProviderDraft;

export type ProviderAdminService = {
  listProviders: typeof listProviders;
  addProvider: typeof addProvider;
  updateProvider: typeof updateProvider;
  deleteProvider: typeof deleteProvider;
  getCachedModels: typeof getCachedModels;
};

const providerAdminService: ProviderAdminService = {
  listProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  getCachedModels
};

const providerDrafts = new Map<string, ProviderDraft>();

export async function showProviderAdminPanel(
  ctx: Context,
  options: { edit?: boolean } = {},
  service: ProviderAdminService = providerAdminService
): Promise<void> {
  const key = providerDraftKey(ctx);
  if (key) providerDrafts.delete(key);
  const providers = await service.listProviders();
  const text = providers.length
    ? `<b>AI Providers</b>\n\n共 ${providers.length} 个，点击 Provider 进行编辑或删除。`
    : "<b>AI Providers</b>\n\n还没有配置 Provider。";
  await renderPanel(ctx, text, buildProviderListKeyboard(providers), options.edit);
}

export async function handleProviderAdminCallback(
  ctx: Context,
  data: string,
  service: ProviderAdminService = providerAdminService
): Promise<boolean> {
  if (!data.startsWith("pa:")) return false;
  await safeAnswerCallback(ctx);

  const chatId = ctx.chat?.id;
  if (!chatId) return true;
  const draftKey = providerDraftKey(ctx)!;
  const [, action, indexValue, fingerprint, value] = data.split(":");

  try {
    if (action === "list" || action === "cancel") {
      await showProviderAdminPanel(ctx, { edit: true }, service);
      return true;
    }

    if (action === "add") {
      providerDrafts.set(draftKey, { kind: "add", step: "name", values: {} });
      await renderPanel(ctx, "<b>添加 Provider</b>\n\n请输入 Provider 名称。", buildCancelKeyboard(), true);
      return true;
    }

    if (action === "add_level") {
      const draft = providerDrafts.get(draftKey);
      const level = Number(indexValue);
      const providers = await service.listProviders();
      const maxLevel = getProviderPriorityOptions(providers).at(-1)?.level ?? 0;
      if (draft?.kind !== "add" || draft.step !== "level"
        || !Number.isInteger(level) || level < 0 || level > maxLevel
        || !draft.values.name || !draft.values.baseUrl || !draft.values.apiKey) {
        await showProviderAdminPanel(ctx, { edit: true }, service);
        return true;
      }
      await renderPanel(ctx, "<b>添加 Provider</b>\n\n正在验证连接并获取模型列表...", buildCancelKeyboard(), true);
      const submittedSecret = draft.values.apiKey;
      try {
        const added = await service.addProvider({
          name: draft.values.name,
          baseUrl: draft.values.baseUrl,
          apiKey: draft.values.apiKey,
          mode: "auto",
          level
        });
        providerDrafts.delete(draftKey);
        await showUpdatedProvider(ctx, added, service, true, "Provider 已添加。");
      } catch (error) {
        draft.step = "apiKey";
        draft.values.apiKey = undefined;
        await renderPanel(
          ctx,
          `<b>添加失败</b>\n\n${escapeHtml(safeErrorMessage(error, submittedSecret))}\n\n请重新输入 API Key。`,
          buildCancelKeyboard(),
          true
        );
      }
      return true;
    }

    const resolved = await resolveProvider(service, indexValue, fingerprint);
    if (!resolved) {
      await showProviderAdminPanel(ctx, { edit: true }, service);
      return true;
    }
    const { provider, providers, index } = resolved;

    if (action === "view") {
      await showProviderDetails(ctx, provider, providers, index, true, service);
      return true;
    }

    if (action === "edit" && isEditableField(value)) {
      providerDrafts.set(draftKey, { kind: "edit", providerName: provider.name, field: value });
      const hint = value === "model" ? "输入 - 可清空默认模型。" : "";
      await renderPanel(
        ctx,
        `<b>编辑 ${escapeHtml(provider.name)}</b>\n\n请输入新的 ${fieldLabel(value)}。${hint ? `\n${hint}` : ""}`,
        buildCancelKeyboard(),
        true
      );
      return true;
    }

    if (action === "mode" && isProviderMode(value)) {
      const updated = await service.updateProvider(provider.name, { mode: value });
      await showUpdatedProvider(ctx, updated, service, true);
      return true;
    }

    if (action === "level") {
      const level = Number(value);
      const maxLevel = getProviderPriorityOptions(providers, provider.name).at(-1)?.level ?? 0;
      if (!Number.isInteger(level) || level < 0 || level > maxLevel) {
        await showProviderDetails(ctx, provider, providers, index, true, service);
        return true;
      }
      const updated = await service.updateProvider(provider.name, { level });
      await showUpdatedProvider(ctx, updated, service, true);
      return true;
    }

    if (action === "delete") {
      await renderPanel(
        ctx,
        `<b>删除 Provider</b>\n\n确认删除 <code>${escapeHtml(provider.name)}</code>？此操作无法在 Bot 中撤销。`,
        buildDeleteConfirmKeyboard(index, provider),
        true
      );
      return true;
    }

    if (action === "confirm") {
      await service.deleteProvider(provider.name);
      providerDrafts.delete(draftKey);
      const remaining = await service.listProviders();
      await renderPanel(
        ctx,
        `<b>AI Providers</b>\n\n已删除 <code>${escapeHtml(provider.name)}</code>。`,
        buildProviderListKeyboard(remaining),
        true
      );
      return true;
    }

    if (action === "mode_picker") {
      await renderPanel(
        ctx,
        `<b>编辑 ${escapeHtml(provider.name)}</b>\n\n选择运行模式。`,
        buildModeKeyboard(index, provider),
        true
      );
      return true;
    }

    if (action === "level_picker") {
      await renderPanel(
        ctx,
        `<b>编辑 ${escapeHtml(provider.name)}</b>\n\n选择优先级。`,
        buildLevelKeyboard(index, provider, providers),
        true
      );
      return true;
    }

    await showProviderDetails(ctx, provider, providers, index, true, service);
  } catch (error) {
    await ctx.reply(`Provider 操作失败：${escapeHtml(safeErrorMessage(error))}`, { parse_mode: "HTML" });
  }
  return true;
}

export async function handleProviderAdminInput(
  ctx: Context,
  text: string,
  service: ProviderAdminService = providerAdminService
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  const draftKey = providerDraftKey(ctx)!;
  const draft = providerDrafts.get(draftKey);
  if (!draft || text.startsWith("/")) return false;

  const value = text.trim();
  if (!value) {
    await ctx.reply("输入不能为空。", { reply_markup: buildCancelKeyboard() });
    return true;
  }

  if (draft.kind === "add") {
    if (draft.step === "name") {
      draft.values.name = value;
      draft.step = "baseUrl";
      await ctx.reply("请输入 Provider Base URL。", { reply_markup: buildCancelKeyboard() });
      return true;
    }
    if (draft.step === "baseUrl") {
      if (!isHttpUrl(value)) {
        await ctx.reply("Base URL 必须是有效的 http:// 或 https:// 地址。", { reply_markup: buildCancelKeyboard() });
        return true;
      }
      draft.values.baseUrl = value;
      draft.step = "apiKey";
      await ctx.reply("请输入 Provider API Key。发送后该消息会立即删除。", { reply_markup: buildCancelKeyboard() });
      return true;
    }

    if (draft.step === "apiKey") {
      await deleteSecretMessage(ctx);
      draft.values.apiKey = value;
      draft.step = "level";
      const providers = await service.listProviders();
      await ctx.reply("请选择优先级。0 表示不参与自动切换。", {
        reply_markup: buildAddLevelKeyboard(providers)
      });
    }
    return true;
  }

  const patch = buildEditPatch(draft.field, value);
  if (draft.field === "baseUrl" && !isHttpUrl(value)) {
    await ctx.reply("Base URL 必须是有效的 http:// 或 https:// 地址。", { reply_markup: buildCancelKeyboard() });
    return true;
  }
  if (draft.field === "apiKey") await deleteSecretMessage(ctx);

  try {
    const updated = await service.updateProvider(draft.providerName, patch);
    providerDrafts.delete(draftKey);
    await showUpdatedProvider(ctx, updated, service, false);
  } catch (error) {
    const secret = draft.field === "apiKey" ? value : undefined;
    await ctx.reply(`更新失败：${escapeHtml(safeErrorMessage(error, secret))}`, {
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard()
    });
  }
  return true;
}

export function isProviderSecretInput(chatId: number | undefined, botId?: number): boolean {
  if (!chatId) return false;
  const draft = providerDrafts.get(`${botId ?? "default"}:${chatId}`);
  return Boolean(
    draft?.kind === "add" && draft.step === "apiKey"
    || draft?.kind === "edit" && draft.field === "apiKey"
  );
}

function providerDraftKey(ctx: Context): string | null {
  const chatId = ctx.chat?.id;
  return chatId ? `${ctx.me?.id ?? "default"}:${chatId}` : null;
}

async function showUpdatedProvider(
  ctx: Context,
  updated: Provider,
  service: ProviderAdminService,
  edit: boolean,
  successMessage = "Provider 已更新。"
): Promise<void> {
  const providers = await service.listProviders();
  const index = providers.findIndex((provider) => provider.name === updated.name);
  if (index < 0) {
    await showProviderAdminPanel(ctx, { edit }, service);
    return;
  }
  await showProviderDetails(ctx, providers[index]!, providers, index, edit, service, `${successMessage}\n\n`);
}

async function showProviderDetails(
  ctx: Context,
  provider: Provider,
  providers: Provider[],
  index: number,
  edit: boolean,
  service: ProviderAdminService,
  prefix = ""
): Promise<void> {
  const models = await service.getCachedModels(provider.name).catch(() => []);
  const modelCount = models.length
    ? `\n可用模型：<code>${models.length}</code>\n${escapeHtml(models.slice(0, 20).join(", "))}${models.length > 20 ? " …" : ""}`
    : "";
  const text = [
    prefix,
    `<b>${escapeHtml(truncateText(provider.name, 200))}</b>`,
    "",
    `Base URL：<code>${escapeHtml(truncateText(provider.baseUrl, 500))}</code>`,
    "API Key：<code>已配置</code>",
    `默认模型：<code>${escapeHtml(truncateText(provider.model || "未设置", 200))}</code>`,
    `探测配置：<code>${escapeHtml(describeProviderRequestProfile(provider))}</code>`,
    `模式：<code>${provider.mode}</code>`,
    `优先级：<code>${provider.level}</code>${modelCount}`
  ].join("\n");
  await renderPanel(ctx, text, buildProviderDetailsKeyboard(index, provider), edit);
}

async function resolveProvider(
  service: ProviderAdminService,
  indexValue: string | undefined,
  fingerprint: string | undefined
): Promise<{ provider: Provider; providers: Provider[]; index: number } | null> {
  const index = Number(indexValue);
  if (!Number.isInteger(index) || index < 0 || !fingerprint) return null;
  const providers = await service.listProviders();
  const provider = providers[index];
  if (!provider || providerFingerprint(provider.name) !== fingerprint) return null;
  return { provider, providers, index };
}

function buildProviderListKeyboard(providers: Provider[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, provider] of providers.entries()) {
    keyboard.text(
      `${provider.level}. ${truncateText(provider.name, 32)} · ${provider.mode}`,
      providerCallback("view", index, provider)
    ).row();
  }
  return keyboard.text("添加 Provider", "pa:add");
}

function buildProviderDetailsKeyboard(index: number, provider: Provider): InlineKeyboard {
  const callback = (action: string, value?: string) => providerCallback(action, index, provider, value);
  return new InlineKeyboard()
    .text("名称", callback("edit", "name"))
    .text("Base URL", callback("edit", "baseUrl"))
    .row()
    .text("API Key", callback("edit", "apiKey"))
    .text("默认模型", callback("edit", "model"))
    .row()
    .text("模式", callback("mode_picker"))
    .text("优先级", callback("level_picker"))
    .row()
    .text("删除", callback("delete"))
    .row()
    .text("返回", "pa:list");
}

function buildModeKeyboard(index: number, provider: Provider): InlineKeyboard {
  return new InlineKeyboard()
    .text(provider.mode === "auto" ? "auto（当前）" : "auto", providerCallback("mode", index, provider, "auto"))
    .text(provider.mode === "ask" ? "ask（当前）" : "ask", providerCallback("mode", index, provider, "ask"))
    .row()
    .text("返回", providerCallback("view", index, provider));
}

function buildLevelKeyboard(index: number, provider: Provider, providers: Provider[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const { level } of getProviderPriorityOptions(providers, provider.name)) {
    keyboard.text(
      level === provider.level ? `${level}（当前）` : String(level),
      providerCallback("level", index, provider, String(level))
    );
    if ((level + 1) % 4 === 0) keyboard.row();
  }
  return keyboard.row().text("返回", providerCallback("view", index, provider));
}

function buildAddLevelKeyboard(providers: Provider[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const { level, occupiedBy } of getProviderPriorityOptions(providers)) {
    const label = level === 0
      ? "0（不自动切换）"
      : occupiedBy ? `${level}（替换 ${truncateText(occupiedBy, 18)}）` : `${level}（最低）`;
    keyboard.text(label, `pa:add_level:${level}`);
    if ((level + 1) % 3 === 0) keyboard.row();
  }
  return keyboard.row().text("取消", "pa:cancel");
}

function buildDeleteConfirmKeyboard(index: number, provider: Provider): InlineKeyboard {
  return new InlineKeyboard()
    .text("确认删除", providerCallback("confirm", index, provider))
    .text("取消", providerCallback("view", index, provider));
}

function buildCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("取消", "pa:cancel");
}

function providerCallback(action: string, index: number, provider: Provider, value?: string): string {
  return ["pa", action, index, providerFingerprint(provider.name), value].filter((part) => part !== undefined).join(":");
}

function providerFingerprint(name: string): string {
  return createHash("sha256").update(name).digest("base64url").slice(0, 12);
}

function buildEditPatch(field: EditableProviderField, value: string): Partial<Provider> {
  if (field === "model") return { model: value === "-" ? "" : value };
  return { [field]: value };
}

function isEditableField(value: string | undefined): value is EditableProviderField {
  return value === "name" || value === "baseUrl" || value === "apiKey" || value === "model";
}

function isProviderMode(value: string | undefined): value is ProviderMode {
  return value === "auto" || value === "ask";
}

function fieldLabel(field: EditableProviderField): string {
  if (field === "baseUrl") return "Base URL";
  if (field === "apiKey") return "API Key（发送后该消息会立即删除）";
  if (field === "model") return "默认模型";
  return "Provider 名称";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function safeErrorMessage(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = secret ? message.split(secret).join("[REDACTED]") : message;
  return truncateText(redacted, 500);
}

async function deleteSecretMessage(ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch {
    // Deleting the secret message is best effort; it is still excluded from application logs.
  }
}

async function safeAnswerCallback(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // The callback may already have expired; the requested operation can still continue.
  }
}

async function renderPanel(ctx: Context, text: string, keyboard: InlineKeyboard, edit = false): Promise<void> {
  const options = { parse_mode: "HTML" as const, reply_markup: keyboard };
  if (edit) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch {
      // The originating message may no longer be editable.
    }
  }
  await ctx.reply(text, options);
}
