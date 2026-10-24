import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCodexWebAction, type CodexWebAction } from "../core/web/codex-settings.js";
import { getWebDashboard } from "../core/web/dashboard-service.js";
import { getProviderStatus } from "../core/status/status-service.js";
import { addProvider, deleteProvider, updateProvider } from "../core/providers/provider-service.js";
import { writeLog } from "../core/logs/log-service.js";
import type { Provider, ProviderMode } from "../core/types.js";
import { applyLocalSettings, createSettingsBackup } from "../core/web/local-settings.js";
import { SettingsInputError, saveServiceExposure, createServiceCredential, revokeServiceCredential, rotateServiceCredential, checkServiceConnection } from "../core/config/service-exposure.js";
import { applyClaudeSettings, getClaudeSettings } from "../core/web/claude-settings.js";
import { controlBot } from "../core/services/bot-service.js";
import { callService, serviceVerification } from "../core/web/service-playground.js";
import { queryWebHistory, historyCsv } from "../core/web/history-service.js";
import { prepareSsh } from "../core/services/ssh-setup.js";
import { previewDeployment, executeDeployment } from "../core/services/remote-deployment.js";
import { createApiServiceManager, type ApiServiceAction } from "../core/services/api-service.js";
import { createSshTunnelManager } from "../core/services/ssh-tunnel.js";
import { readModelPricing, removeModelPrice, upsertModelPrice } from "../core/usage/pricing.js";

const ASSET_ROOT = fileURLToPath(new URL("./control/", import.meta.url));
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".ico": "image/x-icon"
};

export type LocalWebServer = { url: string; close(): Promise<void> };

export async function startLocalWebServer(options: { port?: number; assetRoot?: string } = {}): Promise<LocalWebServer> {
  const root = path.resolve(options.assetRoot ?? ASSET_ROOT);
  try {
    await fs.readFile(path.join(root, "console.html"));
  } catch (error) {
    throw new Error("Local Web assets are missing or unreadable. For a source checkout, run `npm ci --prefix web` and `npm run build` in the repository root, then run `ai web` again. For an npm installation, reinstall @offerpilot/axiomruntime.", { cause: error });
  }
  const token = crypto.randomBytes(32).toString("hex");
  let port = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (request.headers.host !== `127.0.0.1:${port}`) {
      sendJson(response, 403, { error: "Invalid host." });
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    try {
      if (pathname.startsWith("/api/")) {
        if (request.headers.authorization !== `Bearer ${token}`) {
          sendJson(response, 401, { error: "Unauthorized." });
          return;
        }
        if (request.method !== "GET" && request.headers.origin !== `http://127.0.0.1:${port}`) {
          sendJson(response, 403, { error: "Invalid origin." });
          return;
        }
        await handleApi(request, response, pathname);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      await serveAsset(response, root, pathname);
    } catch (error) {
      if (error instanceof WebInputError || error instanceof SettingsInputError) sendJson(response, error instanceof WebInputError ? error.status : 400, { error: error.message });
      else sendJson(response, 500, { error: "Operation failed. Check the local Runtime logs for details." });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start local Web server.");
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}/#access=${token}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function handleApi(request: http.IncomingMessage, response: http.ServerResponse, pathname: string): Promise<void> {
  if (pathname === "/api/exposure/ssh-setup" && request.method === "POST") {
    const body = await readBody(request); if (!isRecord(body)) throw new WebInputError("Invalid SSH setup.");
    sendJson(response, 200, await prepareSsh(body)); return;
  }
  if (pathname === "/api/exposure/deployment" && request.method === "POST") {
    const body = await readBody(request); if (!isRecord(body)) throw new WebInputError("Invalid deployment.");
    if (body.action !== "preview" && body.action !== "deploy") throw new WebInputError("Invalid deployment action.");
    sendJson(response, 200, body.action === "preview" ? await previewDeployment(body) : await executeDeployment(body)); return;
  }
  if (pathname === "/api/claude" && request.method === "GET") { sendJson(response, 200, await getClaudeSettings()); return; }
  if (pathname === "/api/claude" && request.method === "POST") {
    const body = await readBody(request); if (!isRecord(body)) throw new WebInputError("Invalid settings.");
    sendJson(response, 200, await applyClaudeSettings(body)); return;
  }
  if (pathname === "/api/bots/control" && request.method === "POST") {
    const body = await readBody(request); if (!isRecord(body)) throw new WebInputError("Invalid Bot action.");
    if (body.action === "delete") await createSettingsBackup();
    sendJson(response, 200, await controlBot(body.name, body.action)); return;
  }
  if (pathname === "/api/exposure/verification" && request.method === "GET") { sendJson(response, 200, await serviceVerification()); return; }
  if (pathname === "/api/exposure/call" && request.method === "POST") {
    const body = await readBody(request, 58 * 1024 * 1024); if (!isRecord(body)) throw new WebInputError("Invalid call.");
    sendJson(response, 200, await callService(body)); return;
  }
  if (pathname === "/api/history" && request.method === "GET") {
    const params = new URL(request.url!, "http://127.0.0.1").searchParams;
    const result = await queryWebHistory(params);
    if (params.get("format") === "csv") {
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="axiom-${result.kind}.csv"`);
      response.end(historyCsv(result.items));
    } else sendJson(response, 200, result);
    return;
  }
  if (pathname.startsWith("/api/exposure/credentials/") && pathname.endsWith("/rotate") && request.method === "POST") {
    const id = pathname.slice("/api/exposure/credentials/".length, -"/rotate".length);
    sendJson(response, 200, await rotateServiceCredential(id)); return;
  }
  if (pathname === "/api/exposure/tunnel" && request.method === "GET") {
    sendJson(response, 200, await createSshTunnelManager().status());
    return;
  }
  if (pathname === "/api/exposure/tunnel" && request.method === "PUT") {
    sendJson(response, 200, await createSshTunnelManager().save(await readBody(request)));
    return;
  }
  if (pathname === "/api/exposure/tunnel" && request.method === "POST") {
    const body = await readBody(request);
    if (!isRecord(body) || typeof body.action !== "string") throw new WebInputError("Invalid tunnel action.");
    const tunnel = createSshTunnelManager();
    sendJson(response, 200, body.action === "test" ? await tunnel.test() : await tunnel.control(body.action as ApiServiceAction));
    return;
  }
  if (pathname === "/api/exposure/service" && request.method === "GET") {
    sendJson(response, 200, await createApiServiceManager().status());
    return;
  }
  if (pathname === "/api/exposure/service" && request.method === "POST") {
    const body = await readBody(request);
    if (!isRecord(body) || typeof body.action !== "string") throw new WebInputError("Invalid service action.");
    sendJson(response, 200, await createApiServiceManager().control(body.action as ApiServiceAction));
    return;
  }
  if (request.method === "POST" && pathname === "/api/exposure/test") {
    const body = await readBody(request);
    if (!isRecord(body)) throw new WebInputError("Invalid test target.");
    sendJson(response, 200, await checkServiceConnection(body.target));
    return;
  }
  if (request.method === "POST" && pathname === "/api/settings") {
    const body = await readBody(request);
    if (!isRecord(body)) throw new WebInputError("Invalid settings action.");
    sendJson(response, 200, await applyLocalSettings(body));
    return;
  }
  if (request.method === "POST" && pathname === "/api/exposure") {
    const body = await readBody(request);
    if (!isRecord(body)) throw new WebInputError("Invalid service configuration.");
    if (body.connectionMode !== undefined && body.connectionMode !== "ssh") {
      const tunnel = await createSshTunnelManager().status();
      if (tunnel.running || tunnel.autostart) throw new WebInputError("请先断开隧道并关闭隧道自启，再切换部署方式。");
    }
    await createSettingsBackup();
    await saveServiceExposure({ publicBaseUrl: body.publicBaseUrl, upstreamUrl: body.upstreamUrl, capabilities: body.capabilities, connectionMode: body.connectionMode });
    await writeLog({ category: "provider", action: "web_service_exposure_updated", message: "Service exposure policy updated." });
    sendJson(response, 200, { effect: "开放范围已保存；API 服务启用此配置后，每个请求检查最新授权。反代与 TLS 需在服务器部署。" });
    return;
  }
  if (request.method === "POST" && pathname === "/api/exposure/credentials") {
    const body = await readBody(request);
    if (!isRecord(body)) throw new WebInputError("Invalid credential request.");
    const result = await createServiceCredential(body.name, body.capabilities, body.policy);
    await writeLog({ category: "provider", action: "web_service_credential_created", message: "Scoped service credential created.", metadata: { credentialId: result.id } });
    sendJson(response, 200, result);
    return;
  }
  if (request.method === "DELETE" && pathname.startsWith("/api/exposure/credentials/")) {
    const id = pathname.slice("/api/exposure/credentials/".length);
    await revokeServiceCredential(id);
    await writeLog({ category: "provider", action: "web_service_credential_revoked", message: "Service credential revoked.", metadata: { credentialId: id } });
    sendJson(response, 200, { effect: "访问凭证已撤销。" });
    return;
  }
  if (request.method === "GET" && pathname === "/api/state") {
    sendJson(response, 200, await getWebDashboard());
    return;
  }
  if (request.method === "GET" && pathname === "/api/pricing") {
    sendJson(response, 200, await readModelPricing());
    return;
  }
  if (request.method === "PUT" && pathname === "/api/pricing") {
    const body = await readBody(request);
    const input = parsePricingInput(body);
    await createSettingsBackup();
    const pricing = await upsertModelPrice(input.providerName, input.model, input.price);
    await writeLog({ category: "provider", action: "web_model_pricing_updated", message: "Model pricing updated from local Web.", metadata: { provider: input.providerName, model: input.model } });
    sendJson(response, 200, pricing);
    return;
  }
  if (request.method === "DELETE" && pathname === "/api/pricing") {
    const body = await readBody(request);
    const input = parsePricingIdentity(body);
    await createSettingsBackup();
    const pricing = await removeModelPrice(input.providerName, input.model);
    await writeLog({ category: "provider", action: "web_model_pricing_removed", message: "Model pricing removed from local Web.", metadata: { provider: input.providerName, model: input.model } });
    sendJson(response, 200, pricing);
    return;
  }
  if (request.method === "POST" && pathname === "/api/codex") {
    const body = await readBody(request);
    if (!isRecord(body) || typeof body.mode !== "string") throw new WebInputError("Invalid Codex action.");
    let action: CodexWebAction;
    if (body.mode === "provider" && typeof body.providerName === "string") {
      action = { mode: "provider", providerName: body.providerName, ...(typeof body.model === "string" ? { model: body.model } : {}) };
    } else if (body.mode === "proxy" && typeof body.value === "string") {
      action = { mode: "proxy", value: body.value };
    } else if (body.mode === "chatgpt") {
      action = { mode: "chatgpt" };
    } else throw new WebInputError("Invalid Codex action.");
    sendJson(response, 200, await applyCodexWebAction(action));
    return;
  }
  if (request.method === "POST" && pathname === "/api/providers/refresh") {
    const body = await readBody(request);
    if (!isRecord(body) || typeof body.name !== "string") throw new WebInputError("Provider name is required.");
    const status = await getProviderStatus(body.name, { refresh: true });
    sendJson(response, 200, { name: status.name, health: status.health, checkedAt: status.lastCheckedAt });
    return;
  }
  if (request.method === "POST" && pathname === "/api/providers") {
    const body = await readBody(request);
    if (!isRecord(body) || typeof body.name !== "string" || typeof body.baseUrl !== "string" || typeof body.apiKey !== "string") throw new WebInputError("Provider name, URL and API Key are required.");
    await createSettingsBackup();
    const provider = await addProvider({ name: body.name, baseUrl: body.baseUrl, apiKey: body.apiKey, model: typeof body.model === "string" ? body.model : undefined, mode: body.mode === "ask" ? "ask" : "auto", level: typeof body.level === "number" ? body.level : undefined });
    sendJson(response, 200, { name: provider.name });
    return;
  }
  if (request.method === "PATCH" && pathname.startsWith("/api/providers/")) {
    const name = decodeURIComponent(pathname.slice("/api/providers/".length));
    const body = await readBody(request);
    if (!isRecord(body)) throw new WebInputError("Invalid Provider update.");
    const patch: Partial<Provider> = {};
    for (const key of ["name", "baseUrl", "apiKey", "model"] as const) {
      if (typeof body[key] === "string") patch[key] = body[key];
    }
    if (body.mode === "auto" || body.mode === "ask") patch.mode = body.mode as ProviderMode;
    if (typeof body.level === "number") patch.level = body.level;
    await createSettingsBackup();
    const provider = await updateProvider(name, patch);
    sendJson(response, 200, { name: provider.name });
    return;
  }
  if (request.method === "DELETE" && pathname.startsWith("/api/providers/")) {
    await createSettingsBackup();
    const provider = await deleteProvider(decodeURIComponent(pathname.slice("/api/providers/".length)));
    await writeLog({ category: "provider", action: "web_provider_deleted", message: "Provider deleted from local Web.", metadata: { provider: provider.name } });
    sendJson(response, 200, { name: provider.name });
    return;
  }
  sendJson(response, 404, { error: "Route not found." });
}

async function serveAsset(response: http.ServerResponse, root: string, pathname: string): Promise<void> {
  const relative = pathname === "/" ? "console.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(`${root}${path.sep}`)) throw new WebInputError("Invalid path.", 403);
  const extension = path.extname(filePath);
  if (!MIME_TYPES[extension]) throw new WebInputError("Not found.", 404);
  const content = await fs.readFile(filePath).catch(() => null);
  if (!content) throw new WebInputError("Not found.", 404);
  response.writeHead(200, { "Content-Type": MIME_TYPES[extension] });
  response.end(content);
}

async function readBody(request: http.IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new WebInputError("JSON content type required.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new WebInputError("Request body too large.", 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WebInputError("Invalid JSON."); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parsePricingIdentity(value: unknown): { providerName: string; model: string } {
  if (!isRecord(value) || typeof value.providerName !== "string" || typeof value.model !== "string") {
    throw new WebInputError("Provider 和模型不能为空。");
  }
  const providerName = value.providerName.trim();
  const model = value.model.trim();
  if (!providerName || !model || providerName.length > 120 || model.length > 200) {
    throw new WebInputError("Provider 或模型名称无效。");
  }
  return { providerName, model };
}

function parsePricingInput(value: unknown): { providerName: string; model: string; price: { inputPerMillionUsd: number; outputPerMillionUsd: number; cacheReadPerMillionUsd?: number } } {
  const identity = parsePricingIdentity(value);
  if (!isRecord(value)) throw new WebInputError("价格配置无效。");
  const input = readNonNegativeFiniteNumber(value.inputPerMillionUsd);
  const output = readNonNegativeFiniteNumber(value.outputPerMillionUsd);
  const cache = value.cacheReadPerMillionUsd === undefined || value.cacheReadPerMillionUsd === null || value.cacheReadPerMillionUsd === ""
    ? undefined
    : readNonNegativeFiniteNumber(value.cacheReadPerMillionUsd);
  if (input === undefined || output === undefined || (value.cacheReadPerMillionUsd !== undefined && value.cacheReadPerMillionUsd !== null && value.cacheReadPerMillionUsd !== "" && cache === undefined)) {
    throw new WebInputError("输入、输出价格必须是大于等于 0 的有限数字。");
  }
  return { ...identity, price: { inputPerMillionUsd: input, outputPerMillionUsd: output, ...(cache !== undefined ? { cacheReadPerMillionUsd: cache } : {}) } };
}

function readNonNegativeFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class WebInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
