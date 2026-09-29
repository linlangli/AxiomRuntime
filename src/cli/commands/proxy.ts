import { getProvidersPath, getRuntimeConfigPath } from "../../core/config/paths.js";
import { loadRuntimeConfig, setRuntimeProxy } from "../../core/config/runtime-config.js";
import { readProviders } from "../../core/config/providers-store.js";
import { writeLog } from "../../core/logs/log-service.js";
import { checkProxyEndpoint, configureGlobalProxy, normalizeProxyUrl } from "../../core/network/proxy.js";
import { setProviderProxy } from "../../core/providers/provider-service.js";
import { promptProxyUrl } from "../prompts/proxy.js";
import { promptSelect, promptText } from "../prompts/prompt.js";

const PROXY_USAGE = "Usage: ai proxy [provider] [host-or-url] [port] | ai proxy [provider] --disable";

const RUNTIME_TARGET = "__runtime__";

type ProxyTarget = {
  scope: "runtime" | "provider";
  /** provider scope 下的 Provider 名。 */
  name?: string;
  hostArg?: string;
  portArg?: string;
  disable: boolean;
};

export async function runProxyCommand(
  args: string[],
  options: {
    text?: typeof promptText;
    select?: typeof promptSelect;
    check?: typeof checkProxyEndpoint;
  } = {}
): Promise<void> {
  const providers = await readProviders();
  const runtimeConfig = args.length ? null : await loadRuntimeConfig();
  const target = await resolveTarget(args, providers, runtimeConfig?.proxyUrl, options);

  const currentUrl = target.scope === "provider"
    ? providers.find((provider) => provider.name === target.name)?.proxyUrl
    : runtimeConfig?.proxyUrl;
  if (target.scope === "provider" && target.hostArg === undefined && !target.disable && !currentUrl) {
    console.log(`Provider ${target.name} has no proxy; entering setup. Leave blank to cancel.`);
  }
  // disable 一律短路为 null（两种 scope 的 --disable 都不能掉进交互 prompt）；有 host 参数
  // 则走归一化（provider 模式 host 是第二参、port 是第三参；runtime 模式 host 是首参、
  // port 是第二参），否则进交互流。undefined 才是「取消，保持不变」。
  const proxyUrl = target.disable
    ? null
    : target.hostArg !== undefined
      ? normalizeProxyUrl(target.hostArg, target.portArg)
      : await promptProxyUrl({ currentUrl, text: options.text, select: options.select });
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

  if (target.scope === "provider" && target.name) {
    const updated = await setProviderProxy(target.name, proxyUrl);
    console.log(updated.proxyUrl
      ? `Provider proxy set to: ${updated.proxyUrl}`
      : `Provider proxy cleared for ${target.name}.`);
    console.log(`Updated: ${getProvidersPath()}`);
    console.log(`Applies to ${target.name} model traffic, discovery and probes, and Claude/Codex started with this provider.`);
    await writeLog({
      category: "provider",
      action: "provider_proxy_set",
      message: updated.proxyUrl ? `Provider proxy enabled for ${target.name}.` : `Provider proxy cleared for ${target.name}.`,
      metadata: { provider: target.name, enabled: Boolean(updated.proxyUrl) }
    });
    return;
  }

  const config = await setRuntimeProxy(proxyUrl ?? null);
  configureGlobalProxy(config.proxyUrl ?? null);

  console.log(config.proxyUrl
    ? `AI Runtime default proxy set to: ${config.proxyUrl}`
    : "AI Runtime default proxy cleared.");
  console.log(`Updated: ${getRuntimeConfigPath()}`);
  console.log("The default applies when a provider has no proxy of its own, covering Runtime requests and Claude/Codex launched through `ai`.");

  await writeLog({
    category: "provider",
    action: "runtime_proxy_set",
    message: config.proxyUrl ? "AI Runtime proxy enabled." : "AI Runtime proxy cleared.",
    metadata: { enabled: Boolean(config.proxyUrl) }
  });
}

/** 第一个位置参数与已存在 Provider 名精确匹配则进 Provider 模式；否则按 legacy 视为 host。 */
async function resolveTarget(
  args: string[],
  providers: Awaited<ReturnType<typeof readProviders>>,
  runtimeProxyUrl: string | undefined,
  options: {
    text?: typeof promptText;
    select?: typeof promptSelect;
  }
): Promise<ProxyTarget> {
  const [first, second, third, ...extra] = args;
  if (extra.length) throw new Error(PROXY_USAGE);

  if (first !== undefined) {
    if (first === "--disable") return { scope: "runtime", disable: true };
    const provider = providers.find((item) => item.name === first);
    if (provider) {
      // ai proxy <provider> <host> [port]：port 作为第三参合法（runtime 模式 host + port 的同构延伸）。
      if (args[3] !== undefined) throw new Error(PROXY_USAGE);
      return { scope: "provider", name: provider.name, hostArg: second, portArg: third, disable: second === "--disable" };
    }
    // 首参不是 Provider 名：legacy 全局形态（host [port]）。第二个参数只能是
    // 合法端口——其余组合（如 `ai proxy foo bar`）视为「Provider 不存在」更可诊断。
    if (second !== undefined && !/^\d+$/.test(second.replace(/^:/, ""))) {
      throw new Error(`Provider not found: ${first}`);
    }
    if (third !== undefined) throw new Error(PROXY_USAGE);
    return { scope: "runtime", hostArg: first, portArg: second, disable: false };
  }

  if (!providers.length) {
    return { scope: "runtime", disable: false };
  }

  const askSelect = options.select ?? promptSelect;
  const selected = await askSelect("Proxy target", [
    ...providers.map((provider) => ({
      label: `${provider.name}${provider.proxyUrl ? `  ${provider.proxyUrl}` : ""}`,
      value: provider.name
    })),
    {
      label: `Runtime default${runtimeProxyUrl ? `  ${runtimeProxyUrl}` : "  (not set)"}`,
      value: RUNTIME_TARGET
    }
  ]);
  return selected === RUNTIME_TARGET
    ? { scope: "runtime", disable: false }
    : { scope: "provider", name: selected, disable: false };
}
