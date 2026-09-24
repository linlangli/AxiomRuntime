import { getRuntimeConfigPath } from "../../core/config/paths.js";
import { loadRuntimeConfig, setRuntimeProxy } from "../../core/config/runtime-config.js";
import { writeLog } from "../../core/logs/log-service.js";
import { configureGlobalProxy, normalizeProxyUrl } from "../../core/network/proxy.js";
import { promptProxyUrl } from "../prompts/proxy.js";
import { promptText } from "../prompts/prompt.js";

const PROXY_USAGE = "Usage: ai proxy [host-or-url] [port] | ai proxy off";

export async function runProxyCommand(
  args: string[],
  options: { text?: typeof promptText } = {}
): Promise<void> {
  const [hostArg, portArg, ...extra] = args;
  if (extra.length) throw new Error(PROXY_USAGE);

  const current = hostArg === undefined ? await loadRuntimeConfig() : null;
  const proxyUrl = hostArg === undefined
    ? await promptProxyUrl({ currentUrl: current?.proxyUrl, text: options.text })
    : normalizeProxyUrl(hostArg, portArg);
  const config = await setRuntimeProxy(proxyUrl ?? null);
  configureGlobalProxy(config.proxyUrl ?? null);

  console.log(config.proxyUrl
    ? `AI Runtime proxy set to: ${config.proxyUrl}`
    : "AI Runtime proxy cleared.");
  console.log(`Updated: ${getRuntimeConfigPath()}`);
  console.log("The proxy applies to Runtime requests and Claude/Codex launched through `ai`.");

  await writeLog({
    category: "provider",
    action: "runtime_proxy_set",
    message: config.proxyUrl ? "AI Runtime proxy enabled." : "AI Runtime proxy cleared.",
    metadata: { enabled: Boolean(config.proxyUrl) }
  });
}
