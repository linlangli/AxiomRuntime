import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import net from "node:net";
import type { Provider } from "../types.js";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy"
] as const;

const LOCAL_NO_PROXY_HOSTS = ["127.0.0.1", "localhost", "::1"];
export type ProxyAddressParts = {
  host: string;
  port: string;
};

export function normalizeProxyUrl(hostOrUrl: string, port = ""): string | null {
  const trimmedHost = hostOrUrl.trim();
  if (!trimmedHost) {
    throw new Error("Proxy host is required. Example: 127.0.0.1");
  }
  if (["off", "none", "clear", "disable"].includes(trimmedHost.toLowerCase())) {
    throw new Error("Use the Disable proxy action instead of entering off as an address.");
  }

  const normalizedPort = normalizeProxyPort(port);
  const hostInput = normalizedPort ? trimmedHost.replace(/:$/, "") : trimmedHost;
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(hostInput)
    ? hostInput
    : `http://${hostInput}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid proxy host or URL: ${hostOrUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Proxy must use http:// or https://.");
  }
  if (!parsed.hostname) throw new Error(`Invalid proxy host or URL: ${hostOrUrl}`);
  if (parsed.username || parsed.password) {
    throw new Error("Proxy credentials are not accepted; use a local unauthenticated proxy endpoint.");
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error("Proxy must be an origin only, without a path, query, or fragment.");
  }

  if (normalizedPort) parsed.port = normalizedPort;
  return parsed.origin;
}

export function splitProxyUrl(proxyUrl: string): ProxyAddressParts {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return { host: "", port: "" };
  const parsed = new URL(normalized);
  const hostname = parsed.hostname.includes(":") && !parsed.hostname.startsWith("[")
    ? `[${parsed.hostname}]`
    : parsed.hostname;
  return {
    host: `${parsed.protocol}//${hostname}`,
    port: parsed.port || (parsed.protocol === "https:" ? "443" : "80")
  };
}

export function applyProxyToEnv(env: NodeJS.ProcessEnv, proxyUrl: string | null): NodeJS.ProcessEnv {
  if (!proxyUrl) return { ...env };
  const next = { ...env };
  for (const key of PROXY_ENV_KEYS) next[key] = proxyUrl;
  const noProxy = mergeNoProxy(env.NO_PROXY ?? env.no_proxy ?? "");
  next.NO_PROXY = noProxy;
  next.no_proxy = noProxy;
  return next;
}

export function configureGlobalProxy(proxyUrl: string | null): void {
  setGlobalDispatcher(proxyUrl ? new ProxyAgent(proxyUrl) : new Agent());
}

/** 两级解析：provider.proxyUrl 优先，runtime.json 全局默认兜底。 */
export function resolveProviderProxy(
  provider: Pick<Provider, "proxyUrl"> | undefined,
  globalProxyUrl: string | null | undefined
): string | null {
  const own = provider?.proxyUrl?.trim();
  return own ? own : globalProxyUrl ?? null;
}

export type UpstreamDispatcherOptions = {
  connections?: number;
  headersTimeout?: number;
  bodyTimeout?: number;
};

/** 每次调用新建、由调用方负责 close()（usage proxy / runtime server 的按路由实例用）。 */
export function createUpstreamDispatcher(
  proxyUrl: string | null,
  options: UpstreamDispatcherOptions = {}
): Dispatcher {
  const shared = {
    connections: options.connections ?? 4,
    pipelining: 0,
    headersTimeout: options.headersTimeout,
    bodyTimeout: options.bodyTimeout ?? 0
  };
  return proxyUrl ? new ProxyAgent({ uri: proxyUrl, ...shared }) : new Agent(shared);
}

const proxyDispatcherCache = new Map<string, Dispatcher>();

/** 进程内按 URL 复用的轻量 dispatcher（控制面探测用）；超时由调用方 AbortController 控制。 */
export function getProxyDispatcher(proxyUrl: string): Dispatcher {
  const cached = proxyDispatcherCache.get(proxyUrl);
  if (cached) return cached;
  const dispatcher = new ProxyAgent(proxyUrl);
  proxyDispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

/** 仅供测试清理缓存连接池。 */
export async function closeProxyDispatchers(): Promise<void> {
  const dispatchers = [...proxyDispatcherCache.values()];
  proxyDispatcherCache.clear();
  await Promise.all(dispatchers.map((dispatcher) => dispatcher.close()));
}

export async function checkProxyEndpoint(
  proxyUrl: string,
  timeoutMs = 3_000
): Promise<{ ok: boolean; durationMs: number; error: string | null }> {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return { ok: false, durationMs: 0, error: "Proxy is disabled." };
  const parsed = new URL(normalized);
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let finished = false;
    const finish = (ok: boolean, error: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve({ ok, durationMs: Date.now() - startedAt, error });
    };
    const timeout = setTimeout(
      () => finish(false, `Connection timed out after ${timeoutMs}ms.`),
      timeoutMs
    );
    socket.once("connect", () => finish(true, null));
    socket.once("error", (error) => finish(false, error.message));
  });
}

function normalizeProxyPort(value: string): string {
  const trimmed = value.trim().replace(/^:/, "");
  if (!trimmed) return "";
  if (!/^\d+$/.test(trimmed)) throw new Error(`Invalid proxy port: ${value}`);
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Proxy port must be between 1 and 65535.");
  }
  return String(port);
}

function mergeNoProxy(current: string): string {
  const values = current.split(",").map((value) => value.trim()).filter(Boolean);
  for (const host of LOCAL_NO_PROXY_HOSTS) {
    if (!values.includes(host)) values.push(host);
  }
  return values.join(",");
}
