import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfigRoot } from "./paths.js";
import { readJsonFile, updateJsonFile } from "./json-store.js";

export const SERVICE_CAPABILITIES = [
  { id: "models", name: "模型目录", method: "GET", path: "/v1/models" },
  { id: "chat", name: "对话补全", method: "POST", path: "/v1/chat/completions" },
  { id: "responses", name: "Responses", method: "POST", path: "/v1/responses" },
  { id: "embeddings", name: "向量接口", method: "POST", path: "/v1/embeddings" },
  { id: "agent", name: "Agent 执行", method: "POST", path: "/v1/agent/runs" }
] as const;
export type ServiceCapability = typeof SERVICE_CAPABILITIES[number]["id"];
export type ServiceCredential = { id: string; name: string; tokenHash: string; capabilities: ServiceCapability[]; createdAt: string };
export type ServiceExposureConfig = {
  publicBaseUrl: string;
  upstreamUrl: string;
  capabilities: ServiceCapability[];
  credentials: ServiceCredential[];
  updatedAt: string | null;
};

export class SettingsInputError extends Error {}

export function getServiceExposurePath(): string {
  return path.join(getConfigRoot(), "service-exposure.json");
}

export function validateCapabilities(value: unknown): ServiceCapability[] {
  if (!Array.isArray(value) || value.some(item => !SERVICE_CAPABILITIES.some(capability => capability.id === item))) {
    throw new SettingsInputError("请选择已实现的服务能力。");
  }
  return [...new Set(value)] as ServiceCapability[];
}

export function validateServiceUrl(value: unknown, publicUrl = false): string {
  if (publicUrl && value === "") return "";
  if (typeof value !== "string") throw new SettingsInputError("请输入有效的服务地址。");
  let url: URL;
  try { url = new URL(value); } catch { throw new SettingsInputError("请输入完整的 HTTP(S) 地址。"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new SettingsInputError("服务地址只能包含协议、主机和端口，不能包含路径或凭证。");
  }
  if (publicUrl && url.protocol !== "https:") throw new SettingsInputError("公网入口必须使用 HTTPS。");
  return url.origin;
}

export async function loadServiceExposure(): Promise<ServiceExposureConfig> {
  return readJsonFile(getServiceExposurePath(), {
    publicBaseUrl: "", upstreamUrl: "http://127.0.0.1:8080", capabilities: [], credentials: [], updatedAt: null
  });
}

export async function saveServiceExposure(input: { publicBaseUrl: unknown; upstreamUrl: unknown; capabilities: unknown }): Promise<void> {
  const publicBaseUrl = validateServiceUrl(input.publicBaseUrl, true);
  const upstreamUrl = validateServiceUrl(input.upstreamUrl);
  const capabilities = validateCapabilities(input.capabilities);
  await updateExposure(current => ({ ...current, publicBaseUrl, upstreamUrl, capabilities }));
}

export async function createServiceCredential(name: unknown, input: unknown) {
  if (typeof name !== "string" || !name.trim() || name.length > 80) throw new SettingsInputError("凭证名称需要 1–80 个字符。");
  const capabilities = validateCapabilities(input);
  if (!capabilities.length) throw new SettingsInputError("请至少选择一项凭证权限。");
  const token = `axm_${crypto.randomBytes(32).toString("hex")}`;
  const credential: ServiceCredential = {
    id: crypto.randomUUID(), name: name.trim(), tokenHash: hashToken(token), capabilities, createdAt: new Date().toISOString()
  };
  await updateExposure(current => {
    if (current.credentials.length >= 50) throw new SettingsInputError("最多保存 50 个访问凭证。");
    if (capabilities.some(capability => !current.capabilities.includes(capability))) throw new SettingsInputError("凭证权限必须包含在已开放能力中。");
    return { ...current, credentials: [...current.credentials, credential] };
  });
  return { id: credential.id, token };
}

export async function revokeServiceCredential(id: string): Promise<void> {
  await updateExposure(current => ({ ...current, credentials: current.credentials.filter(credential => credential.id !== id) }));
}

export function authorizeServiceCredential(config: ServiceExposureConfig, token: string): ServiceCapability[] | null {
  const digest = Buffer.from(hashToken(token), "hex");
  const credential = config.credentials.find(item => {
    const expected = Buffer.from(item.tokenHash, "hex");
    return expected.length === digest.length && crypto.timingSafeEqual(expected, digest);
  });
  return credential?.capabilities ?? null;
}

export function serviceExposureSummary(config: ServiceExposureConfig) {
  return { ...config, credentials: config.credentials.map(({ tokenHash, ...credential }) => credential), catalog: SERVICE_CAPABILITIES };
}

export async function checkServiceConnection(target: unknown) {
  if (target !== "upstream" && target !== "public") throw new SettingsInputError("请选择要测试的服务。");
  const config = await loadServiceExposure();
  const baseUrl = target === "public" ? config.publicBaseUrl : config.upstreamUrl;
  if (!baseUrl) throw new SettingsInputError("请先保存服务地址。");
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/health/live`, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    const content = await response.json() as { status?: string };
    return { ok: response.ok && content.status === "ok", target, durationMs: Date.now() - startedAt };
  } catch { return { ok: false, target, durationMs: Date.now() - startedAt }; }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function updateExposure(updater: (current: ServiceExposureConfig) => ServiceExposureConfig): Promise<void> {
  await updateJsonFile(getServiceExposurePath(), await loadServiceExposure(), current => ({ ...updater(current), updatedAt: new Date().toISOString() }));
  await fs.chmod(getServiceExposurePath(), 0o600);
}
