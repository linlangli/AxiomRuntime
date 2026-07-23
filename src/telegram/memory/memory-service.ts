import fs from "node:fs/promises";
import path from "node:path";
import { getMemoryBackupDir } from "../../core/config/paths.js";
import { escapeHtml, truncateText } from "../interaction/formatter.js";
import { MemoryStore } from "./memory-store.js";
import type { MemoryCategory, MemoryDuration, MemoryEntry, MemorySaveInput, MemoryScope } from "./types.js";

export type MemoryServiceOptions = {
  botId: string;
  store?: MemoryStore;
  injectionCharBudget?: number;
  shortTermTtlMs?: number;
};

export type MemoryRememberInput = {
  content: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  title?: string;
  tags?: string[];
  duration?: MemoryDuration;
  ttlMs?: number;
};

const DEFAULT_INJECTION_CHAR_BUDGET = 3000;
const DEFAULT_SHORT_TERM_TTL_MS = 72 * 60 * 60 * 1000;
const PROFILE_TITLE = "用户画像";
const PERSONA_TITLE = "Bot 人设";
const RAW_DESCRIPTION_TITLE = "用户原始自我描述";

export class MemoryService {
  readonly botId: string;
  private readonly store: MemoryStore;
  private readonly ownsStore: boolean;
  private readonly injectionCharBudget: number;
  private readonly shortTermTtlMs: number;

  constructor(options: MemoryServiceOptions) {
    this.botId = options.botId || "default";
    this.store = options.store ?? new MemoryStore();
    this.ownsStore = !options.store;
    this.injectionCharBudget = options.injectionCharBudget ?? DEFAULT_INJECTION_CHAR_BUDGET;
    this.shortTermTtlMs = options.shortTermTtlMs ?? DEFAULT_SHORT_TERM_TTL_MS;
  }

  close(): void {
    if (this.ownsStore) this.store.close();
  }

  getStorePath(): string {
    return this.store.getPath();
  }

  save(chatId: number | string, input: MemorySaveInput): MemoryEntry {
    const normalized = this.normalizeSaveInput(chatId, input);
    return this.store.save(normalized);
  }

  remember(chatId: number | string, input: MemoryRememberInput): MemoryEntry {
    const category = input.category ?? classifyCategory(input.content);
    if (category === "credential") {
      throw new Error("加密记忆尚未启用，凭证类内容不会明文保存。");
    }
    const scope = input.scope ?? defaultScopeForCategory(category);
    const duration = input.duration ?? "permanent";
    const expiresAt = duration === "short_term"
      ? Date.now() + (input.ttlMs ?? this.shortTermTtlMs)
      : null;
    return this.save(chatId, {
      scope,
      category,
      title: input.title ?? inferTitle(input.content, category),
      content: input.content,
      tags: input.tags ?? inferTags(input.content, category),
      duration,
      expiresAt,
      priority: category === "profile" || category === "persona" ? 1 : 0
    });
  }

  saveProfile(chatId: number | string, content: string): MemoryEntry {
    return this.store.upsertSingleton(this.normalizeSaveInput(chatId, {
      scope: "global",
      category: "profile",
      title: PROFILE_TITLE,
      content,
      tags: ["profile"],
      priority: 1,
      duration: "permanent"
    }));
  }

  savePersona(chatId: number | string, content: string): MemoryEntry {
    return this.store.upsertSingleton(this.normalizeSaveInput(chatId, {
      scope: "bot",
      category: "persona",
      title: PERSONA_TITLE,
      content,
      tags: ["persona", this.botId],
      priority: 1,
      duration: "permanent"
    }));
  }

  saveRawDescription(chatId: number | string, content: string): MemoryEntry {
    return this.store.upsertSingleton(this.normalizeSaveInput(chatId, {
      scope: "bot",
      category: "fact",
      title: RAW_DESCRIPTION_TITLE,
      content,
      tags: ["profile", "raw"],
      priority: 0,
      duration: "permanent"
    }));
  }

  getProfile(chatId: number | string): MemoryEntry | null {
    return this.store.getProfile(normalizeChatId(chatId));
  }

  getPersona(chatId: number | string): MemoryEntry | null {
    return this.store.getPersona(normalizeChatId(chatId), this.botId);
  }

  listVisible(chatId: number | string, query?: string, limit = 50): MemoryEntry[] {
    return this.store.listVisible({
      chatId: normalizeChatId(chatId),
      botId: this.botId,
      query,
      limit
    });
  }

  retrieveForPrompt(chatId: number | string, prompt: string): MemoryEntry[] {
    const visible = this.store.listVisible({
      chatId: normalizeChatId(chatId),
      botId: this.botId,
      limit: 200
    });
    if (!visible.length) return [];

    const required = visible.filter((entry) => entry.priority > 0);
    const keywords = extractKeywords(prompt);
    const scored = visible
      .filter((entry) => entry.priority <= 0)
      .map((entry) => ({ entry, score: scoreMemory(entry, keywords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
      .slice(0, 8)
      .map((item) => item.entry);

    return trimEntriesToBudget(dedupeEntries([
      ...sortRequiredEntries(required),
      ...scored
    ]), this.injectionCharBudget);
  }

  delete(chatId: number | string, selector: string): number {
    const value = selector.trim();
    if (!value) return 0;
    if (/^\d+$/.test(value)) {
      return this.store.deleteVisibleById(normalizeChatId(chatId), this.botId, Number(value));
    }
    if (value === "profile") {
      const profile = this.getProfile(chatId);
      return profile ? this.store.deleteVisibleById(normalizeChatId(chatId), this.botId, profile.id) : 0;
    }
    if (value === "persona") {
      const persona = this.getPersona(chatId);
      return persona ? this.store.deleteVisibleById(normalizeChatId(chatId), this.botId, persona.id) : 0;
    }
    return this.store.deleteVisibleByKeyword(normalizeChatId(chatId), this.botId, value);
  }

  promote(chatId: number | string, id: number): MemoryEntry | null {
    return this.store.promote(normalizeChatId(chatId), this.botId, id);
  }

  clearScope(chatId: number | string, scope: MemoryScope): number {
    return this.store.clearScope(normalizeChatId(chatId), this.botId, scope);
  }

  cleanupExpired(now = Date.now()): number {
    return this.store.deleteExpired(now);
  }

  async backup(retain = 7): Promise<string | null> {
    const dbPath = this.store.getPath();
    try {
      await fs.access(dbPath);
    } catch {
      return null;
    }
    const backupDir = getMemoryBackupDir();
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(backupDir, `memory-${stamp}.sqlite`);
    try {
      await fs.copyFile(dbPath, backupPath);
      await pruneBackups(backupDir, retain);
      return backupPath;
    } catch {
      return null;
    }
  }

  formatList(chatId: number | string, query?: string): string {
    const entries = this.listVisible(chatId, query, 30);
    if (!entries.length) return "🤖 还没有记忆。";
    return [
      "🤖 当前记忆",
      "",
      ...entries.map(formatMemorySummary)
    ].join("\n\n");
  }

  private normalizeSaveInput(chatId: number | string, input: MemorySaveInput): Parameters<MemoryStore["save"]>[0] {
    if (!input.content.trim()) {
      throw new Error("记忆内容不能为空。");
    }
    const category = input.category ?? "fact";
    if (category === "credential" && !input.encrypted) {
      throw new Error("加密记忆尚未启用，凭证类内容不会明文保存。");
    }
    const scope = normalizeScope(input.scope ?? defaultScopeForCategory(category), category);
    const duration = input.duration ?? "permanent";
    const expiresAt = duration === "short_term"
      ? input.expiresAt ?? Date.now() + this.shortTermTtlMs
      : null;
    return {
      chatId: normalizeChatId(chatId),
      scope,
      botId: scope === "bot" ? this.botId : null,
      category,
      title: (input.title ?? inferTitle(input.content, category)).trim(),
      content: input.content.trim(),
      tags: normalizeTags(input.tags ?? []),
      priority: input.priority ?? 0,
      duration,
      encrypted: input.encrypted ?? false,
      expiresAt
    };
  }
}

export function getBotIdFromToken(token: string | undefined): string {
  const value = String(token ?? "").trim();
  if (!value) return "default";
  return value.split(":", 1)[0] || "default";
}

export function buildFullProfilePrompt(rawDescription: string): string {
  return [
    "根据以下用户的自我描述，生成两份内容，用分隔符 '=====PERSONA=====' 分开。",
    "",
    "<user_description>",
    rawDescription,
    "</user_description>",
    "",
    "第一部分【用户画像】（跨所有助手共享，只描述用户本人）：",
    "- 用户身份、技术背景、通用偏好、通用工作方式",
    "- 不要包含任何特定助手的角色定位",
    "- 500 字符以内",
    "",
    "建议结构：",
    "## 用户背景",
    "## 通用偏好",
    "",
    "第二部分【Bot 人设】（仅本助手使用）：",
    "- 本助手的职责域、专业风格、风险边界",
    "- 400 字符以内",
    "",
    "建议结构：",
    "## 角色与职责",
    "## 工作风格",
    "## 风险边界",
    "",
    "通用要求：输出纯文本；中文输入就使用中文；只输出内容本身，不要多余说明。"
  ].join("\n");
}

export function buildPersonaPrompt(rawDescription: string, existingProfile: string): string {
  return [
    "已知用户画像如下（勿修改、勿重复其中内容）：",
    "<existing_profile>",
    existingProfile,
    "</existing_profile>",
    "",
    "用户希望本助手承担的职责描述：",
    "<bot_description>",
    rawDescription,
    "</bot_description>",
    "",
    "生成本助手的 Bot 人设，要求：",
    "- 只描述本助手的职责域、专业风格、风险边界",
    "- 400 字符以内；中文输入就使用中文",
    "",
    "建议结构：",
    "## 角色与职责",
    "## 工作风格",
    "## 风险边界",
    "",
    "只输出人设内容，不要多余说明。"
  ].join("\n");
}

export function splitProfileAndPersona(value: string): { profile: string; persona: string } {
  const [profile, ...rest] = value.split("=====PERSONA=====");
  return {
    profile: profile?.trim() || value.trim(),
    persona: rest.join("=====PERSONA=====").trim()
  };
}

function normalizeChatId(chatId: number | string): string {
  return String(chatId);
}

function normalizeScope(scope: MemoryScope, category: MemoryCategory): MemoryScope {
  if (category === "profile") return "global";
  if (category === "persona" || category === "credential") return "bot";
  return scope;
}

function defaultScopeForCategory(category: MemoryCategory): MemoryScope {
  if (category === "profile") return "global";
  if (category === "persona" || category === "credential" || category === "note" || category === "skill") return "bot";
  return "global";
}

function classifyCategory(content: string): MemoryCategory {
  const text = content.toLowerCase();
  if (/密码|账号|token|api[_ -]?key|secret|credential|password/.test(text)) return "credential";
  if (/偏好|喜欢|习惯|prefer|preference/.test(text)) return "preference";
  if (/明天|今天|本周|临时|提醒|todo|计划/.test(text)) return "note";
  return "fact";
}

function inferTitle(content: string, category: MemoryCategory): string {
  const firstLine = content.trim().split(/\r?\n/, 1)[0] ?? "";
  const title = firstLine.replace(/^#+\s*/, "").trim();
  if (title) return truncateText(title, 40);
  if (category === "preference") return "偏好";
  if (category === "note") return "临时笔记";
  return "记忆";
}

function inferTags(content: string, category: MemoryCategory): string[] {
  const tags = new Set<string>([category]);
  for (const match of content.matchAll(/#([\p{L}\p{N}_-]+)/gu)) {
    tags.add(match[1]!);
  }
  return [...tags].slice(0, 8);
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const value = String(tag).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= 12) break;
  }
  return result;
}

function extractKeywords(prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2);
  return [...new Set(words)].slice(0, 20);
}

function scoreMemory(entry: MemoryEntry, keywords: string[]): number {
  if (!keywords.length) return 0;
  const haystack = `${entry.title}\n${entry.content}\n${entry.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) score += entry.title.toLowerCase().includes(keyword) ? 3 : 1;
  }
  if (entry.category === "preference") score += 1;
  if (entry.category === "note") score += 0.5;
  return score;
}

function sortRequiredEntries(entries: MemoryEntry[]): MemoryEntry[] {
  const order: Record<MemoryCategory, number> = {
    persona: 0,
    profile: 1,
    preference: 2,
    fact: 3,
    note: 4,
    skill: 5,
    credential: 6
  };
  return [...entries].sort((a, b) => order[a.category] - order[b.category] || b.updatedAt - a.updatedAt);
}

function dedupeEntries(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<number>();
  const result: MemoryEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

function trimEntriesToBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
  const required = entries.filter((entry) => entry.priority > 0);
  const optional = entries.filter((entry) => entry.priority <= 0);
  const result = [...required];
  let used = required.reduce((sum, entry) => sum + entry.content.length + entry.title.length, 0);
  for (const entry of optional) {
    const cost = entry.content.length + entry.title.length;
    if (used + cost > budget && result.length) continue;
    result.push(entry);
    used += cost;
    if (used >= budget) break;
  }
  return result;
}

function formatMemorySummary(entry: MemoryEntry): string {
  const scope = entry.scope === "global" ? "global" : "bot";
  const expiry = entry.expiresAt ? `\nExpires：<code>${escapeHtml(new Date(entry.expiresAt).toISOString())}</code>` : "";
  return [
    `<b>#${entry.id} ${escapeHtml(entry.title)}</b>`,
    `Scope：<code>${scope}</code> · Category：<code>${entry.category}</code>`,
    `Content：${escapeHtml(truncateText(entry.encrypted ? "(encrypted)" : entry.content, 220))}${expiry}`
  ].join("\n");
}

async function pruneBackups(backupDir: string, retain: number): Promise<void> {
  const entries = await fs.readdir(backupDir).catch(() => []);
  const files = entries
    .filter((name) => /^memory-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
    .sort()
    .reverse();
  await Promise.all(files.slice(retain).map((name) => fs.rm(path.join(backupDir, name), { force: true })));
}
