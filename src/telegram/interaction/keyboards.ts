import { InlineKeyboard } from "grammy";
import type { TelegramPermissionMode } from "../config.js";

export function buildApprovalKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Allow", `perm:approve:${id}`)
    .text("Deny", `perm:deny:${id}`)
    .row()
    .text("Allow all", `perm:approve_all:${id}`)
    .text("Skip", `perm:skip:${id}`);
}

export function buildWorkdirStartKeyboard(hasExistingWorkdirs: boolean, scope: "setup" | "ready" = "setup"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (hasExistingWorkdirs) {
    keyboard.text("已存在", `${scope}:workdir:list`);
  } else {
    keyboard.text("已存在", `${scope}:workdir:list_empty`);
  }
  return keyboard.text("自定义", `${scope}:workdir:custom`);
}

export function buildWorkdirListKeyboard(workdirs: string[], scope: "setup" | "ready" = "setup"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, cwd] of workdirs.slice(0, 8).entries()) {
    keyboard.text(cwd, `${scope}:workdir:pick:${index}`).row();
  }
  return keyboard.text("back", `${scope}:workdir:back`);
}

export function buildCliKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Claude Code", "setup:cli:claude")
    .text("Codex", "setup:cli:codex");
}

export function buildAgentProfileKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("暂不提供", "setup:agent:skip");
}

export function buildAgentProfileBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("back", "ready:back");
}

export function buildReadyKeyboard(input: {
  cli: string;
  providerModel: string;
  permissionMode: TelegramPermissionMode;
  cwd: string;
}): InlineKeyboard {
  return new InlineKeyboard()
    .text(input.cli, "ready:cli")
    .row()
    .text(input.providerModel, "ready:provider")
    .row()
    .text(formatPermissionModeLabel(input.permissionMode), "ready:mode")
    .row()
    .text(input.cwd, "ready:workdir")
    .row()
    .text("BOT", "ready:agent");
}

export function buildReadyCliKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Claude Code", "ready:cli:pick:claude")
    .text("Codex", "ready:cli:pick:codex")
    .row()
    .text("back", "ready:back");
}

export function buildReadyProviderKeyboard(providers: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, provider] of providers.entries()) {
    keyboard.text(provider, `ready:provider:pick:${index}`).row();
  }
  return keyboard.text("back", "ready:back");
}

export function buildReadyModelKeyboard(models: string[], providerIndex: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, model] of models.entries()) {
    keyboard.text(model, `ready:model:pick:${providerIndex}:${index}`).row();
  }
  return keyboard.text("back", "ready:provider");
}

export function buildReadyModeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("默认权限", "ready:mode:pick:default")
    .row()
    .text("接受编辑", "ready:mode:pick:acceptEdits")
    .row()
    .text("跳过权限", "ready:mode:pick:bypassPermissions")
    .row()
    .text("back", "ready:back");
}

export function buildUsagePricingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("输入价格", "usage:price:input")
    .text("未知", "usage:price:unknown");
}

export function formatPermissionModeLabel(mode: TelegramPermissionMode): string {
  if (mode === "acceptEdits") return "接受编辑";
  if (mode === "bypassPermissions") return "跳过权限";
  return "默认权限";
}
