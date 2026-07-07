import type { ExecutionResult, ProgressUpdate } from "../engine/types.js";
import type { TelegramSession } from "../session/types.js";

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

export function formatCodeBlock(code: string, language = ""): string {
  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre><code${className}>${escapeHtml(truncateText(code, 3500))}</code></pre>`;
}

export function splitPlainText(value: string, maxLength = 3800): string[] {
  if (value.length <= maxLength) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    const newlineIndex = remaining.lastIndexOf("\n", maxLength);
    const splitAt = newlineIndex > maxLength * 0.6 ? newlineIndex + 1 : maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export const Formatter = {
  workdirPrompt(): string {
    return "🤖 你好呀，先确定工作路径吧。";
  },

  workdirRequired(): string {
    return "🤖 请选确定工作路径哦";
  },

  workdirList(workdirs: string[]): string {
    if (!workdirs.length) {
      return "🤖 还没有记录过工作路径，点“自定义”新建一个吧。";
    }
    return [
      "📁 <b>选择一个已有工作路径</b>",
      "",
      ...workdirs.map((cwd, index) => `${index + 1}. <code>${escapeHtml(cwd)}</code>`)
    ].join("\n");
  },

  customWorkdirPrompt(): string {
    return [
      "✏️ <b>输入工作目录名称</b>",
      "",
      "我会固定创建或使用：",
      "<code>~/你输入的名称</code>"
    ].join("\n");
  },

  cliPrompt(cwd: string): string {
    return [
      "✅ <b>工作路径已确定</b>",
      "",
      `📁 <code>${escapeHtml(cwd)}</code>`,
      "",
      "🤖 接下来选择你想使用的 CLI。"
    ].join("\n");
  },

  cliRequired(): string {
    return "🤖 先确定你想使用的CLI哦。";
  },

  sessionCard(session: TelegramSession, provider?: { name: string; model: string }, error?: string): string {
    const cliName = session.engine === "claude" ? "Claude Code" : "Codex";
    const lines = [
      "✨ <b>会话已就绪</b>",
      "",
      `🆔 <code>${escapeHtml(session.id.slice(0, 8))}</code>`,
      `📁 <b>工作路径</b>\n<code>${escapeHtml(session.cwd)}</code>`,
      `🧰 <b>CLI</b>：${escapeHtml(cliName)}`,
      provider
        ? `🔌 <b>Provider</b>：<code>${escapeHtml(provider.name)}</code>`
        : "🔌 <b>Provider</b>：<code>未配置</code>",
      provider
        ? `🧠 <b>Model</b>：<code>${escapeHtml(provider.model)}</code>`
        : error
          ? `⚠️ <b>Model</b>：${escapeHtml(error)}`
          : "🧠 <b>Model</b>：<code>未配置</code>",
      `🛡️ <b>权限模式</b>：<code>${escapeHtml(session.permissionMode)}</code>`
    ];
    return lines.join("\n");
  },

  taskStarted(engine: string, prompt: string): string {
    return [
      `<b>${engine === "codex" ? "Codex" : "Claude Code"}</b>`,
      "",
      `Prompt: <i>${escapeHtml(truncateText(prompt, 180))}</i>`,
      "Status: processing"
    ].join("\n");
  },

  taskProgress(update: ProgressUpdate): string {
    const phase = {
      thinking: "thinking",
      tool_calling: "calling tool",
      writing: "writing",
      done: "done"
    }[update.phase];
    const suffix = update.tool ? `: <code>${escapeHtml(update.tool)}</code>` : update.message ? `: ${escapeHtml(update.message)}` : "";
    return `Status: ${phase}${suffix}`;
  },

  taskCompleted(result: ExecutionResult, maxOutputLength = 2500): string {
    const parts = ["<b>Done</b>"];
    if (result.provider || result.model) {
      parts.push(`<i>${escapeHtml([result.provider, result.model].filter(Boolean).join(" / "))}</i>`);
    }
    if (result.response) {
      parts.push("", escapeHtml(truncateText(result.response.trim(), maxOutputLength)));
    }
    if (result.filesChanged?.length) {
      parts.push("", "<b>Changed files</b>");
      for (const filePath of result.filesChanged.slice(0, 10)) {
        parts.push(`- <code>${escapeHtml(filePath)}</code>`);
      }
      if (result.filesChanged.length > 10) {
        parts.push(`- and ${result.filesChanged.length - 10} more`);
      }
    }
    if (result.toolCalls?.length) {
      parts.push("", `<b>Tool calls</b>: ${result.toolCalls.length}`);
    }
    const meta: string[] = [];
    if (result.duration) meta.push(`${(result.duration / 1000).toFixed(1)}s`);
    if (result.cost) meta.push(`$${result.cost.toFixed(4)}`);
    if (meta.length) parts.push("", `<i>${escapeHtml(meta.join(" · "))}</i>`);
    return truncateText(parts.join("\n"), TELEGRAM_MESSAGE_LIMIT - 32);
  },

  taskFailed(error: string): string {
    return [`<b>Failed</b>`, "", `<pre>${escapeHtml(truncateText(error, 1500))}</pre>`].join("\n");
  },

  taskAborted(): string {
    return "<b>Stopped</b>";
  },

  help(): string {
    return [
      "<b>AI Gateway Telegram Bot</b>",
      "",
      "首次使用会先选择工作路径和 CLI。",
      "",
      "<b>Commands</b>",
      "/claude prompt - 使用 Claude Code",
      "/codex prompt - 使用 Codex",
      "/reset - 重置并重新选择工作路径和 CLI",
      "/cwd path - 查看或切换工作路径",
      "/help - 查看帮助"
    ].join("\n");
  },

  welcome(name: string): string {
    return [
      `Hello <b>${escapeHtml(name)}</b>`,
      "",
      "AI Gateway Bot is ready. Send /reset to reconfigure."
    ].join("\n");
  }
};
