import type { TelegramEngineName } from "../config.js";
import type { ExecutionResult } from "../engine/types.js";
import type { TelegramSession } from "../session/types.js";

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export type SessionUsageFormatOptions = {
  estimatedCostUsd?: number;
  estimatedCostLabel?: string;
  tokenOnly?: boolean;
  missingPrice?: boolean;
};

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

export function markdownToTelegramHtml(value: string, maxLength = 2500): string {
  const text = truncateText((value || "(empty)").trim(), maxLength);
  if (!text) return "(empty)";
  return renderMarkdownBlocks(text);
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

  agentProfilePrompt(): string {
    return "🤖 介绍一下我和你吧，可以帮你构建画像哦";
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

  agentProfile(content: string): string {
    return [
      "<b>BOT.md</b>",
      "",
      formatCodeBlock(content, "markdown")
    ].join("\n");
  },

  sessionUsage(
    session: TelegramSession,
    provider?: { name: string; model: string },
    error?: string,
    options: SessionUsageFormatOptions = {}
  ): string {
    const providerName = provider?.name ?? "(unknown)";
    const model = provider?.model ?? "(unknown)";
    const usage = provider ? session.providerUsage.find((item) => item.provider === provider.name) : undefined;
    if (options.tokenOnly && usage) {
      return [
        "🤖 当前会话 Token",
        "",
        `Session：<code>${escapeHtml(session.id.slice(0, 8))}</code>`,
        `Provider：<code>${escapeHtml(providerName)}</code>`,
        `Model：<code>${escapeHtml(model)}</code>`,
        `Tokens：<code>${escapeHtml(formatTokenCount(usage.totalTokens))}</code>`
      ].join("\n");
    }
    const lines = [
      "🤖 当前会话用量",
      "",
      `Session：<code>${escapeHtml(session.id.slice(0, 8))}</code>`,
      `Provider：<code>${escapeHtml(providerName)}</code>`,
      `Model：<code>${escapeHtml(model)}</code>`,
      `额度：<code>${escapeHtml(formatProviderCost(usage, options))}</code>`
    ];
    if (usage?.totalTokens) {
      lines.push(`Tokens：<code>${escapeHtml(formatTokenCount(usage.totalTokens))}</code>`);
    }
    if (usage?.cacheReadInputTokens) {
      lines.push(`Cache Read：<code>${escapeHtml(formatTokenCount(usage.cacheReadInputTokens))}</code>`);
    }
    if (options.missingPrice && usage) {
      lines.push("", "当前模型还没有价格表。可以输入价格后计算额度，或选择未知只查看 token。");
    }
    if (error && !provider) {
      lines.push("", `<i>${escapeHtml(truncateText(error, 160))}</i>`);
    }
    return lines.join("\n");
  },

  taskCompleted(engine: TelegramEngineName, result: ExecutionResult, maxOutputLength = 2500): string {
    void engine;
    return markdownToTelegramHtml(result.response || "(empty)", maxOutputLength);
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
      "/fresh - 清空聊天窗口",
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

function renderMarkdownBlocks(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      const language = fence[1] ?? "";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(formatCodeBlock(codeLines.join("\n"), language));
      continue;
    }

    if (!line.trim()) {
      output.push("");
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      output.push(renderMarkdownTable(tableLines));
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      output.push(`<b>${renderMarkdownInline(heading[1])}</b>`);
      index += 1;
      continue;
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (unordered) {
      const indent = "  ".repeat(Math.floor(unordered[1].length / 2));
      output.push(`${indent}• ${renderMarkdownInline(unordered[2])}`);
      index += 1;
      continue;
    }

    const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (ordered) {
      const indent = "  ".repeat(Math.floor(ordered[1].length / 2));
      output.push(`${indent}${line.trimStart().match(/^\d+[.)]/)?.[0] ?? "1."} ${renderMarkdownInline(ordered[2])}`);
      index += 1;
      continue;
    }

    output.push(renderMarkdownInline(line));
    index += 1;
  }

  return output.join("\n");
}

function renderMarkdownInline(value: string): string {
  const placeholders: string[] = [];
  const protect = (html: string): string => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };

  let text = value.replace(/`([^`\n]+)`/g, (_match, code: string) => protect(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, href: string) => {
    const safeHref = escapeHtmlAttribute(href);
    return protect(`<a href="${safeHref}">${escapeHtml(label)}</a>`);
  });

  text = escapeHtml(text);
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");
  text = text.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");

  return text.replace(/\u0000(\d+)\u0000/g, (_match, indexText: string) => placeholders[Number(indexText)] ?? "");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const current = lines[index];
  const next = lines[index + 1];
  return Boolean(
    current?.includes("|") &&
    next &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)
  );
}

function renderMarkdownTable(lines: string[]): string {
  const rows = lines
    .filter((_line, index) => index !== 1)
    .map(parseMarkdownTableRow)
    .filter((row) => row.length > 0);
  if (!rows.length) return "";

  const headers = rows[0] ?? [];
  const dataRows = rows.slice(1);
  if (!headers.length || !dataRows.length) {
    return rows.map((row) => row.map(renderMarkdownInline).join(" / ")).join("\n");
  }

  return dataRows
    .map((row, rowIndex) => renderMarkdownTableItem(headers, row, rowIndex))
    .filter(Boolean)
    .join("\n\n");
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderMarkdownTableItem(headers: string[], row: string[], rowIndex: number): string {
  const title = row[0]?.trim() || `${stripInlineMarkdown(headers[0] ?? "项目")}${rowIndex + 1}`;
  const lines = [`<b>${renderMarkdownInline(title)}</b>`];
  headers.slice(1).forEach((header, index) => {
    const value = row[index + 1]?.trim();
    if (!value) return;
    lines.push(`${escapeHtml(stripInlineMarkdown(header))}：${renderMarkdownInline(value)}`);
  });
  return lines.join("\n");
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]\n]+)]\(([^)]+)\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
}

export function formatUsagePricePrompt(provider: { name: string; model: string }): string {
  return [
    "🤖 输入当前模型价格吧",
    "",
    `Provider：<code>${escapeHtml(provider.name)}</code>`,
    `Model：<code>${escapeHtml(provider.model)}</code>`,
    "",
    "格式：<code>输入价格/输出价格/缓存读取价格</code>",
    "单位：美元 / 百万 tokens",
    "示例：<code>1/3/0.1</code>"
  ].join("\n");
}

export function formatUsagePriceSaved(
  provider: { name: string; model: string },
  inputPrice: number,
  outputPrice: number,
  cacheReadPrice: number
): string {
  return [
    "🤖 价格已保存",
    "",
    `Provider：<code>${escapeHtml(provider.name)}</code>`,
    `Model：<code>${escapeHtml(provider.model)}</code>`,
    `Input：<code>$${inputPrice}/1M tokens</code>`,
    `Output：<code>$${outputPrice}/1M tokens</code>`,
    `Cache Read：<code>$${cacheReadPrice}/1M tokens</code>`
  ].join("\n");
}

export function formatUsagePriceInvalid(): string {
  return [
    "🤖 价格格式不对",
    "",
    "请按 <code>输入价格/输出价格/缓存读取价格</code> 输入，例如 <code>1/3/0.1</code>。"
  ].join("\n");
}

function formatProviderCost(
  usage: TelegramSession["providerUsage"][number] | undefined,
  options: SessionUsageFormatOptions = {}
): string {
  if (!usage) return "$0.0000";
  if (typeof options.estimatedCostUsd === "number" && Number.isFinite(options.estimatedCostUsd)) {
    return `$${options.estimatedCostUsd.toFixed(4)}${options.estimatedCostLabel ?? "（按价格表估算）"}`;
  }
  if (usage.costUsd > 0) {
    const suffix = usage.unknownCostCount > 0 ? ` + ${usage.unknownCostCount} 次未知` : "";
    return `$${usage.costUsd.toFixed(4)}${suffix}`;
  }
  if (usage.unknownCostCount > 0) {
    return usage.totalTokens > 0
      ? `缺少价格表`
      : "额度未知";
  }
  return "$0.0000";
}

function formatTokenCount(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
}
