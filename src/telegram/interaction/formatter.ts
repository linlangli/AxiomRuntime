import type { TelegramEngineName } from "../config.js";
import type { ExecutionResult } from "../engine/types.js";
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
    return "🤖 你好呀，先确定工作路径吧";
  },

  workdirRequired(): string {
    return "🤖 请选确定工作路径哦";
  },

  workdirList(workdirs: string[]): string {
    if (!workdirs.length) {
      return "🤖 还没有记录过工作路径。";
    }
    return "🤖 选择一个已存在的工作路径吧";
  },

  customWorkdirPrompt(): string {
    return [
      "✏️ <b>输入工作目录名称</b>",
      "",
      "我会固定创建或使用：",
      "<code>~/你输入的名称</code>"
    ].join("\n");
  },

  cliPrompt(_cwd: string): string {
    return "🤖 确定你要使用的CLI吧";
  },

  cliRequired(): string {
    return "🤖 先确定你想使用的CLI哦。";
  },

  sessionCard(session: TelegramSession, provider?: { name: string; model: string }, error?: string): string {
    const suffix = error && !provider ? `\n\n<i>${escapeHtml(truncateText(error, 160))}</i>` : "";
    return `🤖 会话<code>${escapeHtml(session.id.slice(0, 8))}</code>已就绪，可以开始和我聊天啦${suffix}`;
  },

  sessionCleared(session: TelegramSession): string {
    return `🤖 会话<code>${escapeHtml(session.id.slice(0, 8))}</code>聊天记录已清理`;
  },

  configPanel(): string {
    return "🤖 Telegram Bot 配置";
  },

  sessionUsage(session: TelegramSession, provider?: { name: string; model: string }, error?: string): string {
    const providerName = provider?.name ?? "(unknown)";
    const model = provider?.model ?? "(unknown)";
    const usage = provider ? session.providerUsage.find((item) => item.provider === provider.name) : undefined;
    const lines = [
      "🤖 当前会话用量",
      "",
      `Session：<code>${escapeHtml(session.id.slice(0, 8))}</code>`,
      `Provider：<code>${escapeHtml(providerName)}</code>`,
      `Model：<code>${escapeHtml(model)}</code>`,
      `额度：<code>${escapeHtml(formatProviderCost(usage))}</code>`
    ];
    if (error && !provider) {
      lines.push("", `<i>${escapeHtml(truncateText(error, 160))}</i>`);
    }
    return lines.join("\n");
  },

  taskCompleted(engine: TelegramEngineName, result: ExecutionResult, maxOutputLength = 2500): string {
    void engine;
    return escapeHtml(truncateText((result.response || "(empty)").trim(), maxOutputLength));
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
      "/reset - 重置会话信息",
      "/fresh - 清空会话聊天记录",
      "/cwd path - 查看或切换工作路径",
      "/config - 查看或编辑 Bot 配置",
      "/usage - 查看当前会话额度",
      "/help - 查看帮助"
    ].join("\n");
  },

  welcome(name: string): string {
    return [
      `Hello <b>${escapeHtml(name)}</b>`,
      "",
      "AI Gateway Bot is ready. Send /reset to reset session info."
    ].join("\n");
  }
};

function formatProviderCost(usage: TelegramSession["providerUsage"][number] | undefined): string {
  if (!usage) return "$0.0000";
  if (usage.costUsd > 0) {
    const suffix = usage.unknownCostCount > 0 ? ` + ${usage.unknownCostCount} 次未知` : "";
    return `$${usage.costUsd.toFixed(4)}${suffix}`;
  }
  if (usage.unknownCostCount > 0) return "额度未知";
  return "$0.0000";
}
