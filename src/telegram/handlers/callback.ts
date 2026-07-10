import type { Bot } from "grammy";
import type { TelegramPermissionMode } from "../config.js";
import {
  askCustomWorkdir,
  completeAgentProfile,
  selectCli,
  selectReadyCli,
  selectReadyMode,
  selectReadyModel,
  selectSetupModel,
  showAgentProfile,
  setWorkdir,
  showReadyCard,
  showReadyCliPicker,
  showReadyModePicker,
  showReadyModelPicker,
  showReadyProviderPicker,
  showSetupModelPicker,
  showSetupProviderPicker,
  showWorkdirList,
  showWorkdirStart
} from "./setup.js";
import { runCliInit, type MessageHandlerDeps } from "./message.js";
import { handleMemoryManageCallback, handleRememberScopeCallback, type RememberScopeMode } from "./memory.js";
import { askUsagePrice, showUsagePanel } from "./usage.js";

export function registerCallbackHandler(bot: Bot, deps: MessageHandlerDeps & {
  bot?: Bot;
}): void {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("perm:")) {
      const [, action, id] = data.split(":");
      if (!id) {
        await ctx.answerCallbackQuery({ text: "Invalid permission request." });
        return;
      }
      if (action === "approve") {
        deps.approvalManager.resolve(id, true);
        await ctx.answerCallbackQuery({ text: "Allowed" });
        return;
      }
      if (action === "deny" || action === "skip") {
        deps.approvalManager.resolve(id, false);
        await ctx.answerCallbackQuery({ text: action === "skip" ? "Skipped" : "Denied" });
        return;
      }
      if (action === "approve_all") {
        const session = deps.sessionManager.getOrCreate(chatId);
        deps.sessionManager.update(session.id, { approveAll: true });
        deps.approvalManager.resolve(id, true);
        await ctx.answerCallbackQuery({ text: "Allowed for this session" });
        return;
      }
    }

    if (data.startsWith("setup:")) {
      const [, category, action, first, second, third] = data.split(":");
      const forcedEngine = parseTelegramEngine(category === "model" ? third : second);
      if (category === "provider" && action === "show") {
        await ctx.answerCallbackQuery();
        await showSetupProviderPicker(ctx, deps, { edit: true, forcedEngine: parseTelegramEngine(first), reselect: Boolean(first) });
        return;
      }
      if (category === "provider" && action === "pick" && first) {
        await ctx.answerCallbackQuery();
        await showSetupModelPicker(ctx, deps, Number(first), { forcedEngine });
        return;
      }
      if (category === "model" && action === "pick" && first && second) {
        await ctx.answerCallbackQuery({ text: "Provider / Model 已选择" });
        await selectSetupModel(ctx, deps, Number(first), Number(second), { forcedEngine });
        return;
      }
      if (category === "workdir" && action === "list") {
        await ctx.answerCallbackQuery();
        await showWorkdirList(ctx, deps, { edit: true });
        return;
      }
      if (category === "workdir" && action === "list_empty") {
        await ctx.answerCallbackQuery({ text: "还没有记录过工作路径" });
        await showWorkdirList(ctx, deps, { edit: true });
        return;
      }
      if (category === "workdir" && action === "custom") {
        await ctx.answerCallbackQuery();
        await askCustomWorkdir(ctx, deps);
        return;
      }
      if (category === "workdir" && action === "back") {
        const session = deps.sessionManager.getOrCreate(chatId);
        deps.sessionManager.update(session.id, { setupStep: "workdir" });
        await ctx.answerCallbackQuery();
        await showWorkdirStart(ctx, deps, { edit: true });
        return;
      }
      if (category === "workdir" && action === "pick" && first) {
        const cwd = resolveWorkdirCallbackValue(first, deps.sessionManager.getWorkdirs(chatId));
        if (!cwd) {
          await ctx.answerCallbackQuery({ text: "工作路径不存在" });
          await showWorkdirList(ctx, deps);
          return;
        }
        await ctx.answerCallbackQuery({ text: "工作路径已选择" });
        await setWorkdir(ctx, deps, cwd, {
          edit: true,
          afterSet: (next) => runCliInit(ctx, deps, next.engine)
        });
        return;
      }
      if (category === "cli" && (action === "claude" || action === "codex")) {
        await ctx.answerCallbackQuery({ text: `CLI: ${action}` });
        await selectCli(ctx, deps, action);
        return;
      }
      if (category === "agent" && action === "skip") {
        await ctx.answerCallbackQuery({ text: "已跳过画像" });
        await completeAgentProfile(ctx, deps, undefined, { edit: true });
        return;
      }
    }

    if (data.startsWith("ready:")) {
      const [, category, action, first, second, third] = data.split(":");
      const forcedEngine = parseTelegramEngine(category === "model" ? third : second);
      if (category === "back") {
        await ctx.answerCallbackQuery();
        await showReadyCard(ctx, deps, deps.sessionManager.getOrCreate(chatId), { edit: true });
        return;
      }
      if (category === "cli" && !action) {
        await ctx.answerCallbackQuery();
        await showReadyCliPicker(ctx, deps);
        return;
      }
      if (category === "agent" && !action) {
        await ctx.answerCallbackQuery();
        await showAgentProfile(ctx, deps);
        return;
      }
      if (category === "provider" && action === "show") {
        await ctx.answerCallbackQuery();
        await showReadyProviderPicker(ctx, deps, { forcedEngine: parseTelegramEngine(first), reselect: Boolean(first) });
        return;
      }
      if (category === "cli" && action === "pick" && (first === "claude" || first === "codex")) {
        await ctx.answerCallbackQuery({ text: `CLI: ${first}` });
        await selectReadyCli(ctx, deps, first);
        return;
      }
      if (category === "provider" && !action) {
        await ctx.answerCallbackQuery();
        await showReadyProviderPicker(ctx, deps);
        return;
      }
      if (category === "provider" && action === "pick" && first) {
        await ctx.answerCallbackQuery();
        await showReadyModelPicker(ctx, deps, Number(first), { forcedEngine });
        return;
      }
      if (category === "model" && action === "pick" && first && second) {
        await ctx.answerCallbackQuery({ text: "Provider / Model 已更新" });
        await selectReadyModel(ctx, deps, Number(first), Number(second), { forcedEngine });
        return;
      }
      if (category === "mode" && !action) {
        await ctx.answerCallbackQuery();
        await showReadyModePicker(ctx);
        return;
      }
      if (category === "mode" && action === "pick" && isTelegramPermissionMode(first)) {
        await ctx.answerCallbackQuery({ text: "权限模式已更新" });
        await selectReadyMode(ctx, deps, first);
        return;
      }
      if (category === "workdir" && !action) {
        const session = deps.sessionManager.getOrCreate(chatId);
        deps.sessionManager.update(session.id, { setupStep: "workdir" });
        await ctx.answerCallbackQuery();
        await showWorkdirStart(ctx, deps, { edit: true, scope: "ready" });
        return;
      }
      if (category === "workdir" && action === "list") {
        await ctx.answerCallbackQuery();
        await showWorkdirList(ctx, deps, { edit: true, scope: "ready" });
        return;
      }
      if (category === "workdir" && action === "list_empty") {
        await ctx.answerCallbackQuery({ text: "还没有记录过工作路径" });
        await showWorkdirList(ctx, deps, { edit: true, scope: "ready" });
        return;
      }
      if (category === "workdir" && action === "custom") {
        await ctx.answerCallbackQuery();
        await askCustomWorkdir(ctx, deps, { edit: true, returnToReady: true });
        return;
      }
      if (category === "workdir" && action === "back") {
        const session = deps.sessionManager.getOrCreate(chatId);
        deps.sessionManager.update(session.id, { setupStep: "ready" });
        await ctx.answerCallbackQuery();
        await showReadyCard(ctx, deps, deps.sessionManager.getOrCreate(chatId), { edit: true });
        return;
      }
      if (category === "workdir" && action === "pick" && first) {
        const cwd = resolveWorkdirCallbackValue(first, deps.sessionManager.getWorkdirs(chatId));
        if (!cwd) {
          await ctx.answerCallbackQuery({ text: "工作路径不存在" });
          await showWorkdirList(ctx, deps, { scope: "ready" });
          return;
        }
        await ctx.answerCallbackQuery({ text: "工作路径已更新" });
        await setWorkdir(ctx, deps, cwd, {
          returnToReady: true,
          edit: true,
          afterSet: (next) => runCliInit(ctx, deps, next.engine)
        });
        return;
      }
    }

    if (data.startsWith("usage:")) {
      const [, category, action] = data.split(":");
      if (category === "price" && action === "input") {
        await ctx.answerCallbackQuery();
        await askUsagePrice(ctx, deps, { edit: true });
        return;
      }
      if (category === "price" && action === "unknown") {
        await ctx.answerCallbackQuery({ text: "只显示 token" });
        await showUsagePanel(ctx, deps, { edit: true, tokenOnly: true });
        return;
      }
    }

    if (data.startsWith("memory:remember:scope:")) {
      const mode = parseRememberScopeMode(data.split(":")[3]);
      if (!mode) {
        await ctx.answerCallbackQuery({ text: "Invalid memory scope." });
        return;
      }
      await ctx.answerCallbackQuery();
      await handleRememberScopeCallback(ctx, deps, mode);
      return;
    }

    if (data.startsWith("memory:manage:")) {
      const [, , action, scope] = data.split(":");
      await ctx.answerCallbackQuery();
      await handleMemoryManageCallback(ctx, deps, parseMemoryManageAction(action), scope);
      return;
    }

    await ctx.answerCallbackQuery();
  });
}

function resolveWorkdirCallbackValue(value: string, workdirs: string[]): string | null {
  if (/^\d+$/.test(value)) {
    return workdirs[Number(value)] ?? null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isTelegramPermissionMode(value: string | undefined): value is TelegramPermissionMode {
  return value === "default" || value === "acceptEdits" || value === "bypassPermissions";
}

function parseTelegramEngine(value: string | undefined): "claude" | "codex" | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

function parseRememberScopeMode(value: string | undefined): RememberScopeMode | null {
  return value === "global" || value === "bot" || value === "auto" ? value : null;
}

function parseMemoryManageAction(value: string | undefined): "panel" | "promote" | "clear" | "clear_confirm" {
  if (value === "promote" || value === "clear" || value === "clear_confirm") return value;
  return "panel";
}
