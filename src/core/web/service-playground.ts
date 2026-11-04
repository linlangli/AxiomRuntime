import crypto from "node:crypto";
import path from "node:path";
import { getConfigRoot } from "../config/paths.js";
import { readJsonFile, writeJsonFile } from "../config/json-store.js";
import { loadServiceExposure, SettingsInputError, SERVICE_CAPABILITIES } from "../config/service-exposure.js";
import { loadSshTunnel } from "../services/ssh-tunnel.js";

async function fingerprint() {
  return crypto.createHash("sha256").update(JSON.stringify([await loadServiceExposure(), await loadSshTunnel()])).digest("hex");
}

export async function serviceVerification() {
  const record = await readJsonFile<{ fingerprint: string; verifiedAt: string } | null>(path.join(getConfigRoot(), "service-verification.json"), null);
  return { verified: !!record && record.fingerprint === await fingerprint(), verifiedAt: record?.verifiedAt ?? null };
}

export async function callService(input: Record<string, unknown>, transport: typeof fetch = fetch) {
  const config = await loadServiceExposure();
  const capability = SERVICE_CAPABILITIES.find(item => item.id === input.capability);
  if (!capability || !config.capabilities.includes(capability.id)) throw new SettingsInputError("请先开放该能力。");
  if (typeof input.token !== "string" || !input.token.trim() || /[\r\n]/.test(input.token)) throw new SettingsInputError("请输入调用凭证，仅用于本次请求，不保存。");
  if (input.target !== "local" && input.target !== "public") throw new SettingsInputError("测试目标无效。");
  const base = input.target === "public" ? config.publicBaseUrl : "http://127.0.0.1:8080";
  if (!base) throw new SettingsInputError("请先保存公网入口。");
  const headers: Record<string, string> = { Authorization: `Bearer ${input.token}` };
  let body: string | FormData | undefined;
  if (capability.method === "POST") {
    if (capability.id === "image_edits") {
      const data = input.body as Record<string, unknown>;
      if (!data || !Array.isArray(data.images) || data.images.length < 1 || data.images.length > 8) throw new SettingsInputError("请上传 1–8 张参考图。");
      const form = new FormData();
      for (const key of ["model", "prompt", "size", "n", "response_format"]) if (data[key] !== undefined) form.set(key, String(data[key]));
      let total = 0;
      for (const image of data.images as Array<{ data: string; type: string }>) {
        if (!image || typeof image.data !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(image.type)) throw new SettingsInputError("参考图格式无效。");
        const bytes = Buffer.from(image.data, "base64"); total += bytes.length;
        if (bytes.length > 20 * 1024 * 1024 || total > 40 * 1024 * 1024) throw new SettingsInputError("参考图体积超限。");
        form.append("image", new Blob([bytes], { type: image.type }), "reference");
      }
      body = form;
    } else {
      if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw new SettingsInputError("请求体应为 JSON 对象。");
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ ...input.body, stream: false });
    }
  }
  const startedAt = Date.now();
  const currentFingerprint = await fingerprint();
  let response: Response;
  try { response = await transport(`${base}${capability.path}`, { method: capability.method, headers, body, redirect: "error", signal: AbortSignal.timeout(capability.id === "agent" ? 620_000 : 180_000) }); }
  catch { throw new SettingsInputError("连接失败或超时；请求可能已被处理，请检查调用记录后决定是否重试。"); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  if (reader) for (;;) {
    const part = await reader.read(); if (part.done) break;
    length += part.value.length;
    if (length > 40 * 1024 * 1024) { await reader.cancel(); throw new SettingsInputError("响应超出 40 MiB，请减少图片数量或改用 URL 输出。"); }
    chunks.push(part.value);
  }
  const text = Buffer.concat(chunks).toString();
  let result: unknown;
  try { result = JSON.parse(text); } catch { result = text.slice(0, 20_000); }
  const payload = result && typeof result === "object" ? result as Record<string, unknown> : null;
  const valid = !!payload && !payload.error && (capability.id === "models" || capability.id === "embeddings" ? Array.isArray(payload.data) : capability.id.startsWith("image") ? Array.isArray(payload.data) && payload.data.length > 0 : capability.id === "chat" ? Array.isArray(payload.choices) && payload.choices.length > 0 : capability.id === "responses" ? payload.object === "response" : capability.id === "agent" ? payload.object === "agent.run" && typeof payload.response === "string" : "result" in payload);
  const verified = response.ok && valid && input.target === "public" && currentFingerprint === await fingerprint();
  if (verified) await writeJsonFile(path.join(getConfigRoot(), "service-verification.json"), { fingerprint: currentFingerprint, verifiedAt: new Date().toISOString() });
  return { ok: response.ok && valid, status: response.status, durationMs: Date.now() - startedAt, requestId: response.headers.get("x-request-id"), result, verified };
}
