import { ProxyAgent, setGlobalDispatcher } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { ApiClientOptions } from "grammy";
import { normalizeProxyUrl } from "../core/network/proxy.js";
import type { TelegramConfig } from "./config.js";

export function getTelegramProxyUrl(config: Pick<TelegramConfig, "proxyUrl">): string | null {
  const value = config.proxyUrl
    ?? process.env.AI_GATEWAY_TELEGRAM_PROXY
    ?? process.env.HTTPS_PROXY
    ?? process.env.https_proxy
    ?? process.env.ALL_PROXY
    ?? process.env.all_proxy
    ?? process.env.HTTP_PROXY
    ?? process.env.http_proxy
    ?? null;
  return value ? normalizeProxyUrl(value) : null;
}

export function configureTelegramNetwork(config: Pick<TelegramConfig, "proxyUrl">): string | null {
  const proxyUrl = getTelegramProxyUrl(config);
  if (!proxyUrl) return null;
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  return proxyUrl;
}

export function createTelegramApiClientOptions(proxyUrl: string | null): ApiClientOptions | undefined {
  if (!proxyUrl) return undefined;
  return {
    baseFetchConfig: {
      agent: new HttpsProxyAgent(proxyUrl)
    } as NonNullable<ApiClientOptions["baseFetchConfig"]>
  };
}

export async function checkTelegramApi(token: string, proxyUrl?: string): Promise<{
  ok: boolean;
  status?: number;
  username?: string;
  error?: string;
}> {
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    clearTimeout(timeout);
    const body = await response.json() as {
      ok?: boolean;
      result?: { username?: string };
      description?: string;
    };
    return {
      ok: Boolean(response.ok && body.ok),
      status: response.status,
      username: body.result?.username,
      error: body.description
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    };
  }
}
