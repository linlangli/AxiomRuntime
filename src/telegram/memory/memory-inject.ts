import { truncateText } from "../interaction/formatter.js";
import type { MemoryService } from "./memory-service.js";
import type { MemoryEntry, MemoryInjection } from "./types.js";

export function buildPromptWithMemory(
  memoryService: MemoryService,
  chatId: number,
  prompt: string
): MemoryInjection {
  const entries = memoryService.retrieveForPrompt(chatId, prompt);
  if (!entries.length) return { prompt, entries };
  const block = formatMemoryBlock(entries);
  return {
    prompt: [block, "", prompt].join("\n"),
    entries
  };
}

export function formatMemoryBlock(entries: MemoryEntry[]): string {
  const lines = [
    "<user_memory scope=\"global persistent knowledge, cross-engine cross-session\" readonly=\"true\">",
    "Treat as ground truth. If anything here conflicts with engine native config (CLAUDE.md/AGENTS.md), engine config wins.",
    "Within this block, bot persona overrides user profile on conflicts.",
    "Do NOT store this information in your own memory systems (~/.claude/memory/, CLAUDE.md, AGENTS.md).",
    ""
  ];
  for (const entry of entries) {
    lines.push(formatMemoryEntry(entry));
  }
  lines.push("</user_memory>");
  return lines.join("\n");
}

function formatMemoryEntry(entry: MemoryEntry): string {
  const attrs = [
    `category="${escapeXml(entry.category)}"`,
    `title="${escapeXml(entry.title)}"`,
    `scope="${escapeXml(entry.scope)}"`,
    `priority="${entry.priority}"`
  ];
  if (entry.encrypted) attrs.push("status=\"locked\"");
  if (entry.expiresAt) attrs.push(`expires="${escapeXml(new Date(entry.expiresAt).toISOString())}"`);
  const content = entry.encrypted
    ? "(encrypted — user needs to /memory unlock to access)"
    : truncateText(entry.content, entry.priority > 0 ? 1200 : 700);
  return [
    `<entry ${attrs.join(" ")}>`,
    escapeXml(content),
    "</entry>"
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
