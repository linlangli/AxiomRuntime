import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfigRoot, getTelegramBotDir } from "../config/paths.js";
import { readJsonFile, writeJsonFile, withJsonFileLock } from "../config/json-store.js";
import { loadRuntimeConfig, setRuntimeFailover, setRuntimeProxy } from "../config/runtime-config.js";
import { loadBotConfig, updateBotConfig } from "../config/telegram-config.js";
import { SettingsInputError, loadServiceExposure, serviceExposureSummary } from "../config/service-exposure.js";
import { checkProxyEndpoint, normalizeProxyUrl, configureGlobalProxy } from "../network/proxy.js";
import { listProviders, setProviderProxy } from "../providers/provider-service.js";
import { clearMemoryEmbeddingConfig, getMemoryEmbeddingConfig, setMemoryEmbeddingConfig } from "../memory/memory-config.js";
import { checkMemoryEmbeddingConfig, checkAndRecordMemoryEmbeddingConfig } from "../memory/embedding-check.js";
import { writeLog } from "../logs/log-service.js";

const MANAGED_FILES = ["runtime.json", "providers.json", "memory.json", "model-pricing.json", "telegram.json", "service-exposure.json"];
const BOT_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const BACKUP_ID = /^[a-f0-9-]{36}$/;

export async function getLocalSettings() {
  const [runtime, embedding, botNames, exposure, backups] = await Promise.all([
    loadRuntimeConfig(), getMemoryEmbeddingConfig(), listConfiguredBots(), loadServiceExposure(), listSettingsBackups()
  ]);
  const bots = await Promise.all(botNames.map(async name => {
    const { token, ...config } = await loadBotConfig(name);
    return { name, ...config, tokenConfigured: Boolean(token) };
  }));
  const safeEmbedding = embedding ? {
    name: embedding.name, baseUrl: embedding.baseUrl, model: embedding.model, providerType: embedding.providerType,
    queryTask: embedding.queryTask ?? "", passageTask: embedding.passageTask ?? "", dimensions: embedding.dimensions,
    credentialConfigured: Boolean(embedding.apiKey), lastCheckedAt: embedding.lastCheckedAt
  } : null;
  return { runtime, embedding: safeEmbedding, bots, exposure: serviceExposureSummary(exposure), backups, managedFiles: MANAGED_FILES };
}

export async function applyLocalSettings(input: Record<string, unknown>) {
  const action = input.action;
  if (action === "backup") return createSettingsBackup();
  if (action === "restore") {
    await restoreSettingsBackup(stringValue(input.id));
    return { effect: "配置已恢复；已运行的 CLI、Bot 和 API 服务可能需要重启。" };
  }
  if (action === "embedding-check") {
    const embedding = await getMemoryEmbeddingConfig();
    if (!embedding) throw new SettingsInputError("请先配置 embedding 服务。");
    const result = await checkAndRecordMemoryEmbeddingConfig(embedding);
    if (result.status !== "ok") throw new SettingsInputError("Embedding 连接测试失败，原配置保留。请检查服务地址、模型与凭证。");
    return { effect: `Embedding 测试成功，向量维度 ${result.dimensions}。` };
  }
  if (!["failover", "proxy", "telegram", "embedding", "embedding-clear"].includes(String(action))) throw new SettingsInputError("未知的配置操作。");
  const backup = await createSettingsBackup();
  if (action === "failover") {
    if (typeof input.enabled !== "boolean") throw new SettingsInputError("自动切换状态必须是布尔值。");
    await setRuntimeFailover(!input.enabled);
  } else if (action === "proxy") {
    const proxy = normalizeSettingsProxy(input.value);
    if (proxy && !(await checkProxyEndpoint(proxy)).ok) throw new SettingsInputError("代理端点无法连接，原配置保留。");
    if (input.provider) await setProviderProxy(stringValue(input.provider), proxy);
    else { await setRuntimeProxy(proxy); configureGlobalProxy(proxy); }
  } else if (action === "telegram") {
    const name = stringValue(input.name);
    if (!BOT_NAME.test(name)) throw new SettingsInputError("Bot 名称只支持 1–32 位小写字母、数字、短横线和下划线。");
    if (input.defaultEngine !== "claude" && input.defaultEngine !== "codex") throw new SettingsInputError("请选择有效的执行引擎。");
    if (!Array.isArray(input.allowedUserIds) || input.allowedUserIds.some(id => !Number.isSafeInteger(id) || Number(id) <= 0)) throw new SettingsInputError("用户白名单必须是正整数 ID。");
    const providerName = stringValue(input.provider);
    if (providerName && !(await listProviders()).some(provider => provider.name === providerName)) throw new SettingsInputError("所选 Provider 不存在。");
    const cwd = stringValue(input.defaultCwd);
    if (!path.isAbsolute(cwd) || !(await fs.stat(cwd).catch(() => null))?.isDirectory()) throw new SettingsInputError("工作目录必须是本机已存在的绝对路径。");
    const proxy = normalizeSettingsProxy(input.proxyUrl);
    if (proxy && !(await checkProxyEndpoint(proxy)).ok) throw new SettingsInputError("Bot 代理端点无法连接。");
    await updateBotConfig(name, {
      defaultEngine: input.defaultEngine, defaultCwd: cwd, allowedUserIds: input.allowedUserIds as number[], allowAllUsers: false,
      provider: providerName || undefined, model: stringValue(input.model) || undefined, proxyUrl: proxy ?? undefined,
      ...(!(await listConfiguredBots()).includes(name) ? { defaultPermissionMode: "default" as const } : {}),
      ...(typeof input.token === "string" && input.token.trim() ? { token: input.token.trim() } : {})
    });
  } else if (action === "embedding-clear") await clearMemoryEmbeddingConfig();
  else if (action === "embedding") {
    const previous = await getMemoryEmbeddingConfig();
    const baseUrl = stringValue(input.baseUrl);
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new SettingsInputError("Embedding 地址无效。"); }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new SettingsInputError("Embedding 地址必须是无凭证的 HTTP(S) 地址。");
    const candidate = {
      name: stringValue(input.name), baseUrl, apiKey: stringValue(input.apiKey) || previous?.apiKey || "", model: stringValue(input.model),
      providerType: input.providerType === "jina" ? "jina" as const : "openai-compatible" as const,
      queryTask: stringValue(input.queryTask), passageTask: stringValue(input.passageTask)
    };
    if (!candidate.name || !candidate.model || !candidate.apiKey) throw new SettingsInputError("请填写服务名称、模型和凭证。");
    const checked = await checkMemoryEmbeddingConfig({ ...candidate, enabled: true, dimensions: null, updatedAt: new Date().toISOString(), lastCheckedAt: null, lastError: null });
    if (checked.status !== "ok") throw new SettingsInputError("Embedding 测试失败，原配置保留。请检查地址、模型和凭证。");
    await setMemoryEmbeddingConfig({ ...candidate, dimensions: checked.dimensions });
  }
  await writeLog({ category: "provider", action: "web_settings_updated", message: "Local configuration updated.", metadata: { section: action, backupId: backup.id } });
  return { backupId: backup.id, effect: action === "telegram" ? "配置已保存，重启对应 Bot 后生效。" : action === "proxy" ? "代理已保存；请重新启动已运行的 CLI 和 API 服务以使用新网络配置。" : "配置已保存；新请求或新启动的进程使用新配置。" };
}

export async function createSettingsBackup() {
  const files: Record<string, unknown> = {};
  const names = [...MANAGED_FILES, ...(await listConfiguredBots()).map(name => `telegram/bots/${name}.json`)];
  for (const name of names) {
    const content = await fs.readFile(path.join(getConfigRoot(), name), "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    files[name] = content === null ? null : JSON.parse(content);
  }
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await fs.mkdir(backupDirectory(), { recursive: true, mode: 0o700 });
  const file = path.join(backupDirectory(), `${id}.json`);
  await writeJsonFile(file, { id, createdAt, files });
  await fs.chmod(file, 0o600);
  for (const older of (await listSettingsBackups()).slice(20)) await fs.rm(path.join(backupDirectory(), `${older.id}.json`));
  return { id, createdAt };
}

export async function listSettingsBackups(): Promise<Array<{ id: string; createdAt: string }>> {
  const entries = await fs.readdir(backupDirectory()).catch(error => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const backups = await Promise.all(entries.filter(file => BACKUP_ID.test(file.replace(/\.json$/, ""))).map(async file => {
    const value = await readJsonFile<{ id: string; createdAt: string }>(path.join(backupDirectory(), file), { id: "", createdAt: "" });
    return { id: file.replace(/\.json$/, ""), createdAt: value.createdAt };
  }));
  return backups.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
}

async function restoreSettingsBackup(id: string) {
  if (!BACKUP_ID.test(id)) throw new SettingsInputError("备份编号无效。");
  const backup = await readJsonFile<{ files: Record<string, unknown> } | null>(path.join(backupDirectory(), `${id}.json`), null);
  if (!backup?.files || Object.keys(backup.files).some(name => !MANAGED_FILES.includes(name) && !/^telegram\/bots\/[a-z0-9][a-z0-9_-]{0,31}\.json$/.test(name))) throw new SettingsInputError("备份不存在或内容无效。");
  await withJsonFileLock(path.join(getConfigRoot(), ".web-restore"), async () => {
    const previous = await createSettingsBackup();
    const before = await readJsonFile<{ files: Record<string, unknown> }>(path.join(backupDirectory(), `${previous.id}.json`), { files: {} });
    try { await writeBackupFiles(backup.files); }
    catch (error) { await writeBackupFiles(before.files); throw error; }
  });
  configureGlobalProxy((await loadRuntimeConfig()).proxyUrl ?? null);
  await writeLog({ category: "provider", action: "web_settings_restored", message: "Managed Runtime settings restored.", metadata: { backupId: id } });
}

async function writeBackupFiles(files: Record<string, unknown>) {
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(getConfigRoot(), name);
    if (value === null) await fs.rm(file, { force: true });
    else {
      const next = name === "service-exposure.json" ? { ...(value as object), credentials: (await loadServiceExposure()).credentials } : value;
      await writeJsonFile(file, next); await fs.chmod(file, 0o600);
    }
  }
}

async function listConfiguredBots(): Promise<string[]> {
  const files = await fs.readdir(getTelegramBotDir()).catch(error => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  return files.filter(file => file.endsWith(".json") && BOT_NAME.test(file.slice(0, -5))).map(file => file.slice(0, -5)).sort();
}

function backupDirectory() { return path.join(getConfigRoot(), "web-backups"); }
function stringValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function normalizeSettingsProxy(value: unknown) {
  const input = stringValue(value);
  if (!input) return null;
  try { return normalizeProxyUrl(input); }
  catch { throw new SettingsInputError("请输入有效的 HTTP(S) 代理地址。"); }
}
