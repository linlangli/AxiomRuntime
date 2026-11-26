import fs from "node:fs/promises";
import https from "node:https";
import type http from "node:http";
import path from "node:path";
import { fetch } from "undici";
import { createSecureContext } from "node:tls";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { parse } from "smol-toml";
import { codexHome, desktopDir, desktopOrigin, desktopRoutes, desktopSecret } from "../core/integrations/codex-desktop.js";
import { loadRuntimeConfig } from "../core/config/runtime-config.js";
import { SettingsInputError } from "../core/config/service-exposure.js";
import { getProxyDispatcher, normalizeProxyUrl, resolveProviderProxy } from "../core/network/proxy.js";
import { buildProviderAuthHeaders, getProviderAuthScheme } from "../core/providers/provider-request-profile.js";
import { getToolBaseUrl } from "../core/runner/tool-runner.js";
import { streamResponse } from "../core/runner/openai-usage-http.js";
import { recordUsageFromResponse } from "../core/runner/openai-usage-recording.js";
import { newTraceId, withLogContext, writeLog } from "../core/logs/log-service.js";
import { isRecord } from "../core/utils/is-record.js";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "./runtime-server.js";

const official = "https://chatgpt.com/backend-api/codex";
const maxBytes = 32 * 1024 * 1024;

async function officialProxyUrl() {
  try {
    const config = parse(await fs.readFile(path.join(codexHome(), "config.toml"), "utf8"));
    return isRecord(config.proxy) && typeof config.proxy.url === "string" ? normalizeProxyUrl(config.proxy.url) : null;
  } catch {
    return null;
  }
}
const json = (res: http.ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

export function desktopHandler(secret: string, upstreamFetch = fetch) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      if (req.headers.host !== new URL(desktopOrigin).host || req.headers.origin || req.headers["x-axiom-desktop"] !== secret) {
        return json(res, 403, { error: "Desktop credentials required." });
      }
      const url = new URL(req.url ?? "/", desktopOrigin);
      if (req.method === "GET" && url.pathname === "/health") { res.writeHead(204).end(); return; }
      if (!req.headers.authorization?.startsWith("Bearer ")) return json(res, 403, { error: "Desktop credentials required." });
      const catalog = req.method === "GET" && url.pathname === "/v1/models";
      const compact = url.pathname === "/v1/responses/compact";
      if (!catalog && !(req.method === "POST" && (url.pathname === "/v1/responses" || compact))) return json(res, 404, {});
      const routes = await desktopRoutes();
      const globalProxy = (await loadRuntimeConfig()).proxyUrl ?? null;
      const headers: Record<string, string> = { authorization: req.headers.authorization, "content-type": "application/json" };
      for (const key of ["chatgpt-account-id", "originator", "version", "user-agent", "openai-beta"]) {
        if (typeof req.headers[key] === "string") headers[key] = req.headers[key];
      }
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      if (catalog) {
        const proxy = globalProxy ?? await officialProxyUrl();
        const endpoint = new URL(official + "/models");
        if (url.searchParams.has("client_version")) endpoint.searchParams.set("client_version", url.searchParams.get("client_version")!);
        const response = await upstreamFetch(endpoint, { headers, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
          dispatcher: proxy ? getProxyDispatcher(proxy) : undefined });
        if (!response.ok) { await response.body?.cancel(); return json(res, response.status, { error: "Official catalog unavailable." }); }
        const data = await response.json();
        if (!isRecord(data) || !Array.isArray(data.models)) throw new Error("Bad catalog.");
        const models = data.models;
        const aliases = routes.map(({ provider, model, alias }) => {
          const entry = models.find(item => isRecord(item) && item.slug === model);
          return { ...(entry ?? { description: model, shell_type: "shell_command", base_instructions: "Help the user with coding tasks.",
            supported_reasoning_levels: [], support_verbosity: false, truncation_policy: { mode: "tokens", limit: 10000 },
            experimental_supported_tools: [], input_modalities: ["text"] }), priority: 1000, supported_in_api: true,
            slug: alias, display_name: provider.name + " · " + model, visibility: "list", upgrade: null, use_responses_lite: false };
        });
        return json(res, 200, { models: [...models.map(model => ({ ...model, use_responses_lite: false })), ...aliases] });
      }
      let body: Record<string, unknown>;
      try {
        let raw = await readBoundedRequestBody(req, maxBytes);
        if (req.headers["content-encoding"] === "zstd") raw = zstdDecompressSync(raw, { maxOutputLength: maxBytes });
        else if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") return json(res, 415, {});
        const value: unknown = JSON.parse(raw.toString("utf8"));
        if (!isRecord(value) || typeof value.model !== "string") return json(res, 400, {});
        body = value;
      } catch (error) { return json(res, error instanceof RequestBodyTooLargeError ? 413 : 400, {}); }
      const selected = String(body.model);
      const route = routes.find(item => item.alias === selected);
      if (!route && selected.startsWith("axiom-")) return json(res, 404, { error: "Model disabled or unavailable." });
      const base = route ? getToolBaseUrl("codex", route.provider) : official;
      const proxy = route ? resolveProviderProxy(route.provider, globalProxy) : globalProxy ?? await officialProxyUrl();
      const model = route?.model ?? selected;
      const provider = route?.provider.name ?? "ChatGPT";
      const response = await upstreamFetch(base + (compact ? "/responses/compact" : "/responses"), {
        method: "POST", redirect: "error", signal: abort.signal, dispatcher: proxy ? getProxyDispatcher(proxy) : undefined,
        headers: route ? { "content-type": "application/json", ...buildProviderAuthHeaders(route.provider.apiKey, getProviderAuthScheme(route.provider, "openai")) } : headers,
        body: JSON.stringify({ ...body, model })
      });
      res.statusCode = response.status;
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      res.setHeader("content-type", contentType);
      const captured = await streamResponse(response, res);
      res.end();
      await recordUsageFromResponse({ provider, tool: "codex", fallbackModel: model, records: [], text: captured.toString("utf8"), contentType });
      await writeLog({ category: "provider", action: "codex_desktop_request_settled", message: "Desktop request settled.", metadata: { provider, model, status: response.status } });
    } catch {
      if (!res.headersSent) json(res, 502, { error: "Desktop gateway unavailable." });
      else res.destroy();
    }
  };
}

export async function startDesktopTransport(): Promise<{ secret: string; owned: boolean; close(): void }> {
  const secret = await desktopSecret();
  const dir = desktopDir();
  const [cert, key] = await Promise.all(["localhost.pem", "localhost-key.pem"].map(name => fs.readFile(path.join(dir, name)))).catch(() => {
    throw new SettingsInputError("请先配置本机受信任 HTTPS 证书（见使用手册 Codex 桌面端）；未修改 Codex。");
  });
  createSecureContext({ cert, key });
  const identity = new X509Certificate(cert);
  if (!identity.checkIP("127.0.0.1") || Date.parse(identity.validFrom) > Date.now() || Date.parse(identity.validTo) <= Date.now() || !identity.checkPrivateKey(createPrivateKey(key))) {
    throw new SettingsInputError("本机证书已过期或不匹配。");
  }
  const handler = desktopHandler(secret);
  const server = https.createServer({ cert, key }, (req, res) => void withLogContext({ traceId: newTraceId() }, () => handler(req, res)));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(new URL(desktopOrigin).port), "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && await verifyDesktopTransport(cert, secret)) {
      return { secret, owned: false, close: () => undefined };
    }
    throw new SettingsInputError("本机 HTTPS 网关无法监听 127.0.0.1:48567；端口可能被其他进程或旧版 AxiomRuntime 占用。未修改 Codex。");
  }
  return { secret, owned: true, close: () => { server.close(); server.closeAllConnections(); } };
}

function verifyDesktopTransport(cert: Buffer, secret: string): Promise<boolean> {
  return new Promise(resolve => {
    const request = https.get(`${desktopOrigin}/health`, { ca: cert, headers: { "x-axiom-desktop": secret }, signal: AbortSignal.timeout(1500) }, response => {
      response.resume();
      resolve(response.statusCode === 204);
    });
    request.on("error", () => resolve(false));
  });
}
