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

const ASSET_ROOT = fileURLToPath(new URL("./control/", import.meta.url));
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".ico": "image/x-icon"
};

export type LocalWebServer = { url: string; close(): Promise<void> };

export async function startLocalWebServer(options: { port?: number; assetRoot?: string } = {}): Promise<LocalWebServer> {
  const root = path.resolve(options.assetRoot ?? ASSET_ROOT);
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
      if (error instanceof WebInputError) sendJson(response, error.status, { error: error.message });
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
  if (request.method === "GET" && pathname === "/api/state") {
    sendJson(response, 200, await getWebDashboard());
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
    const provider = await updateProvider(name, patch);
    sendJson(response, 200, { name: provider.name });
    return;
  }
  if (request.method === "DELETE" && pathname.startsWith("/api/providers/")) {
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

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new WebInputError("JSON content type required.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new WebInputError("Request body too large.", 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WebInputError("Invalid JSON."); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class WebInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
