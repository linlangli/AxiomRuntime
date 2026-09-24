import { normalizeProxyUrl, splitProxyUrl } from "../../core/network/proxy.js";
import { promptText } from "./prompt.js";

type TextPrompt = typeof promptText;

export const PROXY_HOST_PROMPT = "Proxy host or IP (or off)";
export const PROXY_PORT_PROMPT = "Proxy port";

export async function promptProxyUrl(options: {
  currentUrl?: string;
  optional?: boolean;
  text?: TextPrompt;
} = {}): Promise<string | null | undefined> {
  const askText = options.text ?? promptText;
  const current = options.currentUrl ? splitProxyUrl(options.currentUrl) : null;
  const host = await askText(PROXY_HOST_PROMPT, {
    defaultValue: current?.host ?? ""
  });
  if (!host.trim()) {
    if (options.optional) return undefined;
    throw new Error("Proxy host is required. Enter an IP, hostname, URL, or off.");
  }
  if (["off", "none", "clear", "disable"].includes(host.trim().toLowerCase())) return null;
  const port = await askText(PROXY_PORT_PROMPT, { defaultValue: current?.port ?? "" });
  return normalizeProxyUrl(host, port);
}
