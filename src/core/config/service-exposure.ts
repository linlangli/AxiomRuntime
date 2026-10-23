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
  { id: "images", name: "图片生成", method: "POST", path: "/v1/images/generations" },
  { id: "image_edits", name: "图片编辑", method: "POST", path: "/v1/images/edits" },
  { id: "agent", name: "Agent 执行", method: "POST", path: "/v1/agent/runs" },
  { id: "tools", name: "工具执行", method: "POST", path: "/v1/tools/execute" }
] as const;
export type ServiceCapability = typeof SERVICE_CAPABILITIES[number]["id"];
export type CredentialPolicy = { providers?: string[]; models?: string[]; expiresAt?: string; requestsPerMinute?: number; requestQuota?: number };
export type ServiceCredential = { id: string; name: string; tokenHash: string; capabilities: ServiceCapability[]; createdAt: string; policy?: CredentialPolicy };
export type ServiceExposureConfig = {
  connectionMode?: "local" | "ssh";
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

export async function saveServiceExposure(input: { publicBaseUrl: unknown; upstreamUrl?: unknown; capabilities: unknown; connectionMode?: unknown }): Promise<void> {
  const publicBaseUrl = validateServiceUrl(input.publicBaseUrl, true);
  if (input.connectionMode !== undefined && input.connectionMode !== "ssh" && input.connectionMode !== "local") throw new SettingsInputError("请选择同机反代或 SSH 隧道。");
  const upstreamUrl = input.connectionMode === undefined ? validateServiceUrl(input.upstreamUrl) : input.connectionMode === "ssh" ? "http://127.0.0.1:18080" : "http://127.0.0.1:8080";
  const capabilities = validateCapabilities(input.capabilities);
  await updateExposure(current => ({ ...current, ...(input.connectionMode === undefined ? {} : { connectionMode: input.connectionMode as "local" | "ssh" }), publicBaseUrl, upstreamUrl, capabilities }));
}

export async function createServiceCredential(name: unknown, input: unknown, policyInput: unknown = {}) {
  if (typeof name !== "string" || !name.trim() || name.length > 80) throw new SettingsInputError("凭证名称需要 1–80 个字符。");
  const capabilities = validateCapabilities(input);
  if (!capabilities.length) throw new SettingsInputError("请至少选择一项凭证权限。");
  const token = `axm_${crypto.randomBytes(32).toString("hex")}`;
  const credential: ServiceCredential = {
    id: crypto.randomUUID(), name: name.trim(), tokenHash: hashToken(token), capabilities, createdAt: new Date().toISOString(), policy: validateCredentialPolicy(policyInput)
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
  return findServiceCredential(config, token)?.capabilities ?? null;
}

export function findServiceCredential(config: ServiceExposureConfig, token: string): ServiceCredential | null {
  const digest = Buffer.from(hashToken(token), "hex");
  const credential = config.credentials.find(item => {
    const expected = Buffer.from(item.tokenHash, "hex");
    return expected.length === digest.length && crypto.timingSafeEqual(expected, digest);
  });
  return credential && (!credential.policy?.expiresAt || Date.parse(credential.policy.expiresAt) > Date.now()) ? credential : null;
}

export function validateCredentialPolicy(value: unknown): CredentialPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsInputError("凭证策略格式无效。");
  const input = value as Record<string, unknown>;
  const policy: CredentialPolicy = {};
  for (const key of ["providers", "models"] as const) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || input[key].length > 100 || input[key].some(item => typeof item !== "string" || !item.trim() || item.length > 200)) throw new SettingsInputError("Provider/模型白名单无效。");
    policy[key] = [...new Set(input[key] as string[])];
  }
  for (const key of ["requestsPerMinute", "requestQuota"] as const) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) < 1) throw new SettingsInputError("限流与请求额度必须为正整数。");
    policy[key] = Number(input[key]);
  }
  if (input.expiresAt) {
    if (typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) throw new SettingsInputError("有效期必须是未来时间。");
    policy.expiresAt = new Date(input.expiresAt).toISOString();
  }
  return policy;
}

export async function rotateServiceCredential(id: string) {
  const token = `axm_${crypto.randomBytes(32).toString("hex")}`;
  await updateExposure(current => {
    if (!current.credentials.some(item => item.id === id)) throw new SettingsInputError("凭证不存在。");
    return { ...current, credentials: current.credentials.map(item => item.id === id ? { ...item, tokenHash: hashToken(token) } : item) };
  });
  return { token };
}

export function serviceExposureSummary(config: ServiceExposureConfig) {
  return { ...config, credentials: config.credentials.map(({ tokenHash, ...credential }) => credential), catalog: SERVICE_CAPABILITIES };
}

export async function checkServiceConnection(target: unknown) {
  if (target !== "upstream" && target !== "public") throw new SettingsInputError("请选择要测试的服务。");
  const config = await loadServiceExposure();
  const baseUrl = target === "public" ? config.publicBaseUrl : "http://127.0.0.1:8080";
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
