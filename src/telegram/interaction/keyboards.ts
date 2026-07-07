import { InlineKeyboard } from "grammy";
import path from "node:path";

export function buildApprovalKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Allow", `perm:approve:${id}`)
    .text("Deny", `perm:deny:${id}`)
    .row()
    .text("Allow all", `perm:approve_all:${id}`)
    .text("Skip", `perm:skip:${id}`);
}

export function buildWorkdirStartKeyboard(hasExistingWorkdirs: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (hasExistingWorkdirs) {
    keyboard.text("📁 已存在", "setup:workdir:list").row();
  } else {
    keyboard.text("📁 已存在", "setup:workdir:list_empty").row();
  }
  return keyboard.text("✏️ 自定义", "setup:workdir:custom");
}

export function buildWorkdirListKeyboard(workdirs: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const cwd of workdirs.slice(0, 8)) {
    keyboard.text(`📂 ${path.basename(cwd) || cwd}`, `setup:workdir:pick:${encodeURIComponent(cwd)}`).row();
  }
  return keyboard.text("✏️ 自定义", "setup:workdir:custom");
}

export function buildCliKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🧠 Claude Code", "setup:cli:claude")
    .text("⚙️ Codex", "setup:cli:codex");
}
