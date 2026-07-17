import { InlineKeyboard } from "grammy";
import type { TelegramEngineName, TelegramPermissionMode } from "../config.js";

type PickerScope = "setup" | "ready";

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

export function buildProviderPickerKeyboard(
  providers: string[],
  scope: PickerScope,
  forcedEngine?: TelegramEngineName
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, provider] of providers.entries()) {
    keyboard.text(provider, buildProviderPickCallback(scope, index, forcedEngine));
    if (index < providers.length - 1 || scope === "ready") {
      keyboard.row();
    }
  }
  if (scope === "ready") {
    return keyboard.text("back", "ready:back");
  }
  return keyboard;
}

export function buildModelPickerKeyboard(
  models: string[],
  providerIndex: number,
  scope: PickerScope,
  forcedEngine?: TelegramEngineName
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, model] of models.entries()) {
    keyboard.text(model, buildModelPickCallback(scope, providerIndex, index, forcedEngine)).row();
  }
  return keyboard.text("back", buildModelBackCallback(scope, forcedEngine));
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
    .text(input.cwd, "ready:workdir");
}

export function buildReadyCliKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Claude Code", "ready:cli:pick:claude")
    .text("Codex", "ready:cli:pick:codex")
    .row()
    .text("back", "ready:back");
}

export function buildReadyProviderKeyboard(providers: string[]): InlineKeyboard {
  return buildProviderPickerKeyboard(providers, "ready");
}

export function buildReadyModelKeyboard(models: string[], providerIndex: number): InlineKeyboard {
  return buildModelPickerKeyboard(models, providerIndex, "ready");
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

export function buildRememberScopeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("global", "memory:remember:scope:global")
    .text("bot", "memory:remember:scope:bot")
    .text("auto", "memory:remember:scope:auto");
}

export function buildMemoryManageKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("升级为 global", "memory:manage:promote")
    .row()
    .text("清空 bot 记忆", "memory:manage:clear:bot")
    .row()
    .text("清空 global 记忆", "memory:manage:clear:global");
}

export function buildMemoryClearConfirmKeyboard(scope: MemoryClearScope): InlineKeyboard {
  return new InlineKeyboard()
    .text("确认清空", `memory:manage:clear_confirm:${scope}`)
    .text("取消", "memory:manage:panel");
}

export function formatPermissionModeLabel(mode: TelegramPermissionMode): string {
  if (mode === "acceptEdits") return "接受编辑";
  if (mode === "bypassPermissions") return "跳过权限";
  return "默认权限";
}

export function buildResultKeyboard(hasFullOutput: boolean, hasDiff: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasFullOutput) kb.text("📄 完整输出", "result:full");
  if (hasDiff) kb.text("📝 查看 Diff", "result:diff");
  return kb.row().text("▶️ 继续", "result:continue");
}

type MemoryClearScope = "bot" | "global";

function buildProviderPickCallback(scope: PickerScope, index: number, forcedEngine?: TelegramEngineName): string {
  return ["setup", "ready"].includes(scope) && forcedEngine
    ? `${scope}:provider:pick:${index}:${forcedEngine}`
    : `${scope}:provider:pick:${index}`;
}

function buildModelPickCallback(scope: PickerScope, providerIndex: number, modelIndex: number, forcedEngine?: TelegramEngineName): string {
  return forcedEngine
    ? `${scope}:model:pick:${providerIndex}:${modelIndex}:${forcedEngine}`
    : `${scope}:model:pick:${providerIndex}:${modelIndex}`;
}

function buildModelBackCallback(scope: PickerScope, forcedEngine?: TelegramEngineName): string {
  if (forcedEngine) return `${scope}:provider:show:${forcedEngine}`;
  if (scope === "setup") return "setup:provider:show";
  return `${scope}:provider`;
}
