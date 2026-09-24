import { getRuntimeConfigPath } from "../../core/config/paths.js";
import { loadRuntimeConfig, setRuntimeProxy } from "../../core/config/runtime-config.js";
import { writeLog } from "../../core/logs/log-service.js";
import { checkProxyEndpoint, configureGlobalProxy, normalizeProxyUrl } from "../../core/network/proxy.js";
import { promptProxyUrl } from "../prompts/proxy.js";
import { promptSelect, promptText } from "../prompts/prompt.js";

const PROXY_USAGE = "Usage: ai proxy [host-or-url] [port] | ai proxy --disable";

export async function runProxyCommand(
  args: string[],
  options: {
    text?: typeof promptText;
    select?: typeof promptSelect;
    check?: typeof checkProxyEndpoint;
  } = {}
): Promise<void> {
  const [hostArg, portArg, ...extra] = args;
  if (extra.length) throw new Error(PROXY_USAGE);

  const current = hostArg === undefined ? await loadRuntimeConfig() : null;
  const proxyUrl = hostArg === undefined
    ? await promptProxyUrl({ currentUrl: current?.proxyUrl, text: options.text, select: options.select })
    : hostArg === "--disable"
      ? null
      : normalizeProxyUrl(hostArg, portArg);
  if (proxyUrl === undefined) {
    console.log("Proxy configuration unchanged.");
    return;
  }
  if (proxyUrl) {
    console.log(`Checking proxy endpoint: ${proxyUrl}`);
    const checked = await (options.check ?? checkProxyEndpoint)(proxyUrl);
    if (!checked.ok) {
      throw new Error(`Proxy check failed: ${checked.error ?? "connection failed"} Previous proxy kept.`);
    }
    console.log(`Proxy endpoint reachable (${checked.durationMs}ms).`);
  }
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
