import type { Bot } from "grammy";
import type { ApprovalManager } from "../interaction/approval.js";
import type { SessionManager } from "../session/manager.js";
import { askCustomWorkdir, selectCli, setWorkdir, showWorkdirList } from "./setup.js";

export function registerCallbackHandler(bot: Bot, deps: {
  bot?: Bot;
  approvalManager: ApprovalManager;
  sessionManager: SessionManager;
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
        await showWorkdirList(ctx, deps);
        return;
      }
      if (category === "workdir" && action === "list_empty") {
        await ctx.answerCallbackQuery({ text: "还没有记录过工作路径" });
        await showWorkdirList(ctx, deps);
        return;
      }
      if (category === "workdir" && action === "custom") {
        await ctx.answerCallbackQuery();
        await askCustomWorkdir(ctx, deps);
        return;
      }
      if (category === "workdir" && action === "pick" && value) {
        await ctx.answerCallbackQuery({ text: "工作路径已选择" });
        await setWorkdir(ctx, deps, decodeURIComponent(value));
        return;
      }
      if (category === "cli" && (action === "claude" || action === "codex")) {
        await ctx.answerCallbackQuery({ text: `CLI: ${action}` });
        await selectCli(ctx, deps, action);
        return;
      }
    }

    await ctx.answerCallbackQuery();
  });
}
