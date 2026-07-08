import type { Bot } from "grammy";
import type { TelegramConfig, TelegramPermissionMode } from "../config.js";
import type { ApprovalManager } from "../interaction/approval.js";
import type { SessionManager } from "../session/manager.js";
import {
  askCustomWorkdir,
  selectCli,
  selectReadyCli,
  selectReadyMode,
  selectReadyModel,
  setWorkdir,
  showReadyCard,
  showReadyCliPicker,
  showReadyModePicker,
  showReadyModelPicker,
  showReadyProviderPicker,
  showWorkdirList,
  showWorkdirStart
} from "./setup.js";

export function registerCallbackHandler(bot: Bot, deps: {
  bot?: Bot;
  approvalManager: ApprovalManager;
  sessionManager: SessionManager;
  config?: TelegramConfig;
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
      const [, category, action, value] = data.split(":");
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
      if (category === "workdir" && action === "pick" && value) {
        const cwd = resolveWorkdirCallbackValue(value, deps.sessionManager.getWorkdirs(chatId));
        if (!cwd) {
          await ctx.answerCallbackQuery({ text: "工作路径不存在" });
          await showWorkdirList(ctx, deps);
          return;
        }
        await ctx.answerCallbackQuery({ text: "工作路径已选择" });
        await setWorkdir(ctx, deps, cwd);
        return;
      }
      if (category === "cli" && (action === "claude" || action === "codex")) {
        await ctx.answerCallbackQuery({ text: `CLI: ${action}` });
        await selectCli(ctx, deps, action);
        return;
      }
    }

    if (data.startsWith("ready:")) {
      const [, category, action, first, second] = data.split(":");
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
        await showReadyModelPicker(ctx, deps, Number(first));
        return;
      }
      if (category === "model" && action === "pick" && first && second) {
        await ctx.answerCallbackQuery({ text: "Provider / Model 已更新" });
        await selectReadyModel(ctx, deps, Number(first), Number(second));
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
        await setWorkdir(ctx, deps, cwd, { returnToReady: true, edit: true });
        return;
      }
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
