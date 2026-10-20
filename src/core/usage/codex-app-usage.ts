import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigRoot } from "../config/paths.js";
import { readJsonFile, writeJsonFile, withJsonFileLock } from "../config/json-store.js";
import { readProviders } from "../config/providers-store.js";
import { appendUsageEvents } from "../config/usage-store.js";
import { SettingsInputError } from "../config/service-exposure.js";
import { providerIdForName } from "../integrations/codex-provider-config.js";
import { isRecord } from "../utils/is-record.js";
import { writeLog } from "../logs/log-service.js";
import type { TokenUsage, UsageEvent } from "../types.js";

export type CodexAppUsageConfig = {
  enabled: boolean;
  enabledAt: string | null;
  codexHome: string;
  providerMappings: Record<string, string>;
};
type Cursor = {
  identity: string;
  offset: number;
  droppingLine?: boolean;
  sessionId?: string;
  desktop?: boolean;
  startedAt?: string;
  providerId?: string;
  model?: string;
  totals?: TokenUsage;
  checkpoint?: string;
  unmappedProviderIds?: string[];
};
type SyncState = {
  codexHome: string;
  enabledAt: string | null;
  files: Record<string, Cursor>;
  lastSyncAt: string | null;
  lastError: string | null;
  unmappedProviderIds: string[];
  invalidEvents: number;
};
export type CodexAppUsageStatus = CodexAppUsageConfig & Pick<SyncState, "lastSyncAt" | "lastError" | "unmappedProviderIds" | "invalidEvents">;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const syncs = new Map<string, Promise<CodexAppUsageStatus>>();
const recent = new Map<string, { at: number; status: CodexAppUsageStatus }>();

function configPath() { return path.join(getConfigRoot(), "codex-usage.json"); }
function statePath() { return path.join(getConfigRoot(), "codex-usage-state.json"); }
function lockPath() { return path.join(getConfigRoot(), ".codex-usage-sync"); }
function defaultHome() { return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")); }
function emptyState(config: CodexAppUsageConfig): SyncState {
  return { codexHome: config.codexHome, enabledAt: config.enabledAt, files: {}, lastSyncAt: null, lastError: null, unmappedProviderIds: [], invalidEvents: 0 };
}

export async function getCodexAppUsageConfig(): Promise<CodexAppUsageConfig> {
  const value: unknown = await readJsonFile(configPath(), defaultConfig());
  if (!isRecord(value) || typeof value.enabled !== "boolean" || typeof value.codexHome !== "string" || !path.isAbsolute(value.codexHome)
    || !isRecord(value.providerMappings) || Object.entries(value.providerMappings).some(([identifier, name]) => !validName(identifier) || !validName(name))
    || (value.enabled && (typeof value.enabledAt !== "string" || !Number.isFinite(Date.parse(value.enabledAt))))) {
    throw new SettingsInputError("Codex 用量配置格式无效，请重新保存采集设置。");
  }
  return value as CodexAppUsageConfig;
}

function defaultConfig(): CodexAppUsageConfig {
  return { enabled: false, enabledAt: null, codexHome: defaultHome(), providerMappings: {} };
}

export async function configureCodexAppUsage(input: Record<string, unknown>): Promise<void> {
  await withJsonFileLock(lockPath(), async () => {
    const previous = await getCodexAppUsageConfig().catch(error => {
      if (error instanceof SyntaxError || error instanceof SettingsInputError) return defaultConfig();
      throw error;
    });
    if (typeof input.enabled !== "boolean") throw new SettingsInputError("请选择是否启用 Codex App 用量采集。");
    const requestedHome = input.codexHome ?? previous.codexHome;
    if (typeof requestedHome !== "string" || !path.isAbsolute(requestedHome)) throw new SettingsInputError("Codex 目录必须是本机绝对路径。");
    let codexHome = path.resolve(requestedHome);
    if (input.enabled) {
      try { codexHome = await fs.realpath(codexHome); }
      catch { throw new SettingsInputError("Codex 目录不存在。"); }
      if (!(await fs.stat(codexHome)).isDirectory()) throw new SettingsInputError("Codex 路径必须是目录。");
    }
    const mappings = input.providerMappings ?? previous.providerMappings;
    if (!isRecord(mappings) || Object.keys(mappings).length > 100) throw new SettingsInputError("Provider 映射格式无效。");
    const providers = await readProviders();
    for (const [identifier, name] of Object.entries(mappings)) {
      if (!validName(identifier) || identifier === "ai_gateway_selected" || !validName(name) || !providers.some(provider => provider.name === name)) {
        throw new SettingsInputError("Provider 映射必须指向已配置的 Provider，且不能映射 Runtime 代理会话。");
      }
    }
    const config: CodexAppUsageConfig = {
      enabled: input.enabled, codexHome, providerMappings: mappings as Record<string, string>,
      enabledAt: input.enabled ? previous.enabled && previous.codexHome === codexHome ? previous.enabledAt : new Date().toISOString() : null
    };
    await writeJsonFile(configPath(), config);
    recent.delete(getConfigRoot());
    await writeLog({ category: "system", action: "codex_usage_configured", message: "Codex App usage collection settings updated.", metadata: { enabled: config.enabled, mappings: Object.keys(config.providerMappings).length } });
  });
}

export async function syncCodexAppUsage(options: { force?: boolean } = {}): Promise<CodexAppUsageStatus> {
  const key = getConfigRoot();
  const pending = syncs.get(key);
  if (pending) return pending;
  const cached = recent.get(key);
  if (!options.force && cached && Date.now() - cached.at < 1000) return cached.status;
  const operation = withJsonFileLock(lockPath(), sync).catch(error => failureStatus(defaultConfig(), emptyState(defaultConfig()), error)).then(status => {
    recent.set(key, { at: Date.now(), status });
    return status;
  }).finally(() => syncs.delete(key));
  syncs.set(key, operation);
  return operation;
}

async function sync(): Promise<CodexAppUsageStatus> {
  const config = await getCodexAppUsageConfig();
  if (!config.enabled || !config.enabledAt) return { ...config, ...emptyStatus() };
  let state = emptyState(config);
  const events: UsageEvent[] = [];
  try {
    try {
      const saved: unknown = await readJsonFile(statePath(), null);
      if (isRecord(saved) && saved.codexHome === config.codexHome && saved.enabledAt === config.enabledAt && isRecord(saved.files)
        && Object.values(saved.files).every(validCursor) && Number.isSafeInteger(saved.invalidEvents) && Number(saved.invalidEvents) >= 0) {
        state = { ...state, files: saved.files as Record<string, Cursor>, invalidEvents: Number(saved.invalidEvents), lastSyncAt: typeof saved.lastSyncAt === "string" ? saved.lastSyncAt : null };
      }
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (!(await fs.stat(config.codexHome)).isDirectory()) throw new Error("missing_home");
    const providers = await readProviders();
    const names = new Map<string, Set<string>>();
    for (const provider of providers) {
      for (const identifier of [provider.name, providerIdForName(provider.name)]) {
        const candidates = names.get(identifier) ?? new Set<string>();
        candidates.add(provider.name);
        names.set(identifier, candidates);
      }
    }
    const resolveProvider = (identifier: string): string | undefined => {
      if (Object.hasOwn(config.providerMappings, identifier)) return providers.some(provider => provider.name === config.providerMappings[identifier]) ? config.providerMappings[identifier] : undefined;
      const candidates = names.get(identifier);
      return candidates?.size === 1 ? [...candidates][0] : undefined;
    };
    const files = await sessionFiles(config.codexHome);
    const keys = new Set(files.map(file => crypto.createHash("sha256").update(file).digest("hex")));
    for (const key of Object.keys(state.files)) if (!keys.has(key)) delete state.files[key];
    let remaining = MAX_BYTES;
    for (const file of files) {
      const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (!stat) continue;
      if (!stat.isFile() || stat.mtimeMs < Date.parse(config.enabledAt)) continue;
      const key = crypto.createHash("sha256").update(file).digest("hex");
      const identity = `${stat.dev}:${stat.ino}`;
      let cursor = state.files[key];
      if (!cursor || cursor.identity !== identity || cursor.offset > stat.size
        || cursor.unmappedProviderIds?.some(identifier => resolveProvider(identifier))
        || (cursor.offset > 0 && cursor.checkpoint !== await checkpoint(file, cursor.offset))) cursor = { identity, offset: 0 };
      state.files[key] = cursor;
      if (cursor.desktop === false || cursor.offset === stat.size || remaining <= 0) continue;
      const readLimit = Math.min(remaining, stat.size - cursor.offset);
      remaining -= readLimit;
      await readLines(file, cursor, readLimit, line => {
        try {
          const event: unknown = JSON.parse(line);
          if (!isRecord(event) || !isRecord(event.payload)) return;
          const payload = event.payload;
          if (event.type === "session_meta" && !cursor.sessionId) {
            cursor.sessionId = validName(payload.id) ? payload.id : validName(payload.session_id) ? payload.session_id : undefined;
            cursor.desktop = payload.originator === "Codex Desktop" && validName(payload.model_provider) && payload.model_provider !== "ai_gateway_selected";
            cursor.providerId = validName(payload.model_provider) ? payload.model_provider : undefined;
            cursor.startedAt = typeof payload.timestamp === "string" && Number.isFinite(Date.parse(payload.timestamp)) ? payload.timestamp : undefined;
            if (payload.originator === "Codex Desktop" && (!cursor.sessionId || !cursor.providerId || !cursor.startedAt)) {
              cursor.desktop = false;
              state.invalidEvents += 1;
            }
          } else if (event.type === "turn_context") {
            cursor.model = validName(payload.model) ? payload.model : undefined;
            if (validName(payload.model_provider)) cursor.providerId = payload.model_provider;
          } else if (event.type === "event_msg" && payload.type === "token_count" && isRecord(payload.info)) {
            const totals = tokenUsage(payload.info.total_token_usage);
            if (!cursor.desktop || !cursor.sessionId) return;
            if (!totals) { state.invalidEvents += 1; return; }
            const previous = cursor.totals;
            cursor.totals = totals;
            if (previous && totals.inputTokens === previous.inputTokens && totals.outputTokens === previous.outputTokens && totals.cacheReadInputTokens === previous.cacheReadInputTokens) return;
            const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
            if (!Number.isFinite(timestamp) || timestamp < Date.parse(config.enabledAt!) || timestamp < Date.parse(cursor.startedAt ?? config.enabledAt!) || timestamp > Date.now() + 300_000) return;
            const delta = previous ? subtract(totals, previous) : tokenUsage(payload.info.last_token_usage);
            if (!delta || !delta.totalTokens || delta.inputTokens > totals.inputTokens || delta.outputTokens > totals.outputTokens
              || (delta.cacheReadInputTokens ?? 0) > (totals.cacheReadInputTokens ?? 0)) { state.invalidEvents += 1; return; }
            if (!cursor.providerId || cursor.providerId === "ai_gateway_selected" || !cursor.model) { state.invalidEvents += 1; return; }
            const provider = resolveProvider(cursor.providerId);
            if (!provider) { cursor.unmappedProviderIds = [...new Set([...(cursor.unmappedProviderIds ?? []), cursor.providerId])]; return; }
            const id = crypto.createHash("sha256").update(JSON.stringify([config.codexHome, cursor.sessionId, event.timestamp, totals])).digest("hex");
            events.push({ id: `codex_app:${id}`, source: "codex_app", tool: "codex", provider, model: cursor.model, ...delta, createdAt: new Date(timestamp).toISOString() });
          }
        } catch { state.invalidEvents += 1; }
      });
      cursor.checkpoint = await checkpoint(file, cursor.offset);
    }
    await appendUsageEvents(events);
    state.unmappedProviderIds = [...new Set(Object.values(state.files).flatMap(cursor => cursor.unmappedProviderIds ?? []))].sort();
    state.lastSyncAt = new Date().toISOString();
    await writeJsonFile(statePath(), state);
  } catch (error) {
    return failureStatus(config, state, error);
  }
  return { ...config, lastSyncAt: state.lastSyncAt, lastError: state.lastError, unmappedProviderIds: state.unmappedProviderIds, invalidEvents: state.invalidEvents };
}

function emptyStatus() {
  return { lastSyncAt: null, lastError: null, unmappedProviderIds: [] as string[], invalidEvents: 0 };
}
function failureStatus(config: CodexAppUsageConfig, state: SyncState, error: unknown): CodexAppUsageStatus {
  const code = (error as NodeJS.ErrnoException)?.code;
  return { ...config, lastSyncAt: state.lastSyncAt, unmappedProviderIds: state.unmappedProviderIds, invalidEvents: state.invalidEvents,
    lastError: `Codex App 用量同步失败（${typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "read_error"}）；请检查采集目录或重新保存设置，原账本保留。` };
}
function validCursor(value: unknown): value is Cursor {
  return isRecord(value) && typeof value.identity === "string" && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0
    && (value.unmappedProviderIds === undefined || (Array.isArray(value.unmappedProviderIds) && value.unmappedProviderIds.every(validName)))
    && (value.totals === undefined || (isRecord(value.totals) && tokenUsage({ input_tokens: value.totals.inputTokens, output_tokens: value.totals.outputTokens, cached_input_tokens: value.totals.cacheReadInputTokens }) !== undefined));
}
function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
}
function tokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return;
  const input = value.input_tokens;
  const output = value.output_tokens;
  const cached = value.cached_input_tokens ?? 0;
  if (![input, output, cached].every(count => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return;
  if (Number(cached) > Number(input) || !Number.isSafeInteger(Number(input) + Number(output))
    || (value.total_tokens !== undefined && value.total_tokens !== Number(input) + Number(output))) return;
  return { inputTokens: Number(input), outputTokens: Number(output), totalTokens: Number(input) + Number(output), cacheReadInputTokens: Number(cached) };
}
function subtract(current: TokenUsage, previous: TokenUsage): TokenUsage | undefined {
  return tokenUsage({ input_tokens: current.inputTokens - previous.inputTokens, output_tokens: current.outputTokens - previous.outputTokens, cached_input_tokens: (current.cacheReadInputTokens ?? 0) - (previous.cacheReadInputTokens ?? 0) });
}

async function sessionFiles(codexHome: string): Promise<string[]> {
  const directories = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const files: string[] = [];
  let visited = 0;
  while (directories.length) {
    if (++visited > 4096 || files.length > 50_000) throw new Error("session_limit");
    const directory = directories.pop()!;
    const stat = await fs.lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat?.isDirectory()) continue;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(directory, entry.name));
        if (files.length > 50_000) throw new Error("session_limit");
      }
    }
  }
  return files.sort().reverse();
}

async function checkpoint(file: string, offset: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const length = Math.min(offset, 256);
    const prefix = Buffer.alloc(length);
    const suffix = Buffer.alloc(length);
    await handle.read(prefix, 0, length, 0);
    await handle.read(suffix, 0, length, offset - length);
    return crypto.createHash("sha256").update(prefix).update(suffix).digest("hex");
  } finally { await handle.close(); }
}

async function readLines(file: string, cursor: Cursor, limit: number, consume: (line: string) => void): Promise<void> {
  const stream = createReadStream(file, { start: cursor.offset, end: cursor.offset + limit - 1, highWaterMark: 64 * 1024 });
  let fragments: Buffer[] = [];
  let length = 0;
  let position = cursor.offset;
  for await (const raw of stream) {
    const chunk = raw as Buffer;
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      const part = chunk.subarray(start, end);
      if (!cursor.droppingLine && length + part.length <= MAX_LINE) consume(Buffer.concat([...fragments, part]).toString("utf8"));
      cursor.droppingLine = false;
      fragments = []; length = 0;
      cursor.offset = position + end + 1;
      start = end + 1;
    }
    const remainder = chunk.subarray(start);
    length += remainder.length;
    if (length > MAX_LINE) { cursor.droppingLine = true; fragments = []; }
    else if (!cursor.droppingLine) fragments.push(remainder);
    position += chunk.length;
    if (cursor.droppingLine) cursor.offset = position;
  }
}
