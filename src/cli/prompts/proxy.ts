import { normalizeProxyUrl, splitProxyUrl } from "../../core/network/proxy.js";
import { promptSelect, promptText } from "./prompt.js";

type TextPrompt = typeof promptText;
type SelectPrompt = typeof promptSelect;

export const PROXY_HOST_PROMPT = "Proxy host or IP";
export const PROXY_PORT_PROMPT = "Proxy port";

export async function promptProxyUrl(options: {
  currentUrl?: string;
  optional?: boolean;
  text?: TextPrompt;
  select?: SelectPrompt;
  write?: (message: string) => void;
} = {}): Promise<string | null | undefined> {
  const askText = options.text ?? promptText;
  const askSelect = options.select ?? promptSelect;
  const write = options.write ?? console.log;
  const current = options.currentUrl ? splitProxyUrl(options.currentUrl) : null;
  if (options.currentUrl) {
    write(`Current proxy: ${options.currentUrl}`);
    const action = await askSelect("Proxy action", [
      { label: "Edit proxy", value: "edit" },
      { label: "Disable proxy", value: "disable" },
      { label: "Cancel", value: "cancel" }
    ]);
    if (action === "disable") return null;
    if (action === "cancel") return undefined;
  }
  const hostInput = await askText(PROXY_HOST_PROMPT);
  const host = hostInput.trim() || current?.host || "";
  if (!host) {
    if (options.optional) return undefined;
    throw new Error("Proxy host is required. Enter an IP, hostname, or URL.");
  }
  const portInput = await askText(PROXY_PORT_PROMPT);
  const port = portInput.trim() || current?.port || "";
  return normalizeProxyUrl(host, port);
}
