import { readCache } from "../config/cache-store.js";
import {
  resolveCodexProviderModel,
  setCodexProvider,
  setCodexProxy
} from "../integrations/codex-provider-config.js";
import { writeLog } from "../logs/log-service.js";
import { listProviders } from "../providers/provider-service.js";

export type CodexWebAction =
  | { mode: "provider"; providerName: string; model?: string }
  | { mode: "chatgpt" }
  | { mode: "proxy"; value: string };

export async function applyCodexWebAction(action: CodexWebAction) {
  if (action.mode === "proxy") {
    const result = await setCodexProxy(action.value);
    await writeLog({ category: "provider", action: "codex_proxy_set", message: "Codex proxy updated from local Web.", metadata: { enabled: Boolean(result.proxyUrl), restartScheduled: result.restart.scheduled } });
    return { mode: action.mode, restart: result.restart, proxyUrl: result.proxyUrl };
  }
  if (action.mode === "chatgpt") {
    const result = await setCodexProvider({ type: "chatgpt" });
    await writeLog({ category: "provider", action: "codex_provider_set", message: "Codex switched to ChatGPT from local Web.", metadata: { selection: "chatgpt", restartScheduled: result.restart.scheduled } });
    return { mode: action.mode, restart: result.restart, providerId: result.providerId };
  }
  const [providers, cache] = await Promise.all([listProviders(), readCache()]);
  const provider = providers.find((item) => item.name === action.providerName);
  if (!provider) throw new Error(`Provider not found: ${action.providerName}`);
  const model = resolveCodexProviderModel(provider.name, cache.providers[provider.name]?.models ?? [], action.model);
  const result = await setCodexProvider({ type: "provider", provider, model });
  await writeLog({ category: "provider", action: "codex_provider_set", message: "Codex provider updated from local Web.", metadata: { selection: "provider", provider: provider.name, model, restartScheduled: result.restart.scheduled } });
  return { mode: action.mode, restart: result.restart, providerId: result.providerId, model };
}
