import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { isDeepStrictEqual } from "node:util";
import { getConfigRoot } from "../config/paths.js";
import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { getProviderStatus } from "../status/status-service.js";
import { updateProvider } from "../providers/provider-service.js";
import { withJsonFileLock } from "../config/json-store.js";
import { SettingsInputError } from "../config/service-exposure.js";
import { isModelCompatible } from "../models/model-filter.js";
import type { Provider } from "../types.js";
import { atomicWriteFile, setTopLevelTomlString } from "./codex-provider-config.js";

export const desktopOrigin = "https://127.0.0.1:48567";
export const desktopProviderId = "axiom-desktop";
export const desktopDir = () => path.join(getConfigRoot(), "codex-desktop");
export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

export function desktopModels(provider: Provider, catalog: string[]) {
  return [...new Set([provider.model, ...catalog])].filter(model => {
    if (!model || /image|dall-e|audio|speech|tts|transcrib|embed|rerank|moderat|video|whisper/i.test(model)) return false;
    return isModelCompatible("codex", model) || provider.requestProfile?.verifiedProtocols.includes("openai");
  });
}

export async function desktopRoutes() {
  const [providers, cache] = await Promise.all([readProviders(), readCache()]);
  return providers.filter(provider => provider.codexDesktop).flatMap(provider =>
    desktopModels(provider, cache.providers[provider.name]?.models ?? [])
      .map(model => ({
        provider, model, alias: "axiom-" + createHash("sha256").update(JSON.stringify([provider.name, model])).digest("hex").slice(0, 24)
      })));
}

export async function desktopSecret() {
  const file = path.join(desktopDir(), "access-key");
  return withJsonFileLock(file, async () => {
    try {
      const value = await fs.readFile(file, "utf8");
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid desktop key.");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const value = randomBytes(32).toString("hex");
      await fs.writeFile(file, value, { flag: "wx", mode: 0o600 });
      return value;
    }
  });
}

export async function registerDesktopGateway(secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new SettingsInputError("本机网关密钥格式无效。");
  await setDesktopGatewayConfig(secret);
}

export async function disableDesktopGateway() {
  await setDesktopGatewayConfig();
}

export async function getDesktopGatewayStatus() {
  const config = await readDesktopConfig(path.join(codexHome(), "config.toml"));
  const providerId = parse(config ?? "").model_provider ?? "openai";
  return { enabled: providerId === desktopProviderId, providerId };
}

export async function setDesktopGatewayProvider(name: string, enabled: boolean) {
  if (enabled) {
    const provider = await getProviderStatus(name);
    if (!desktopModels(provider, provider.models).length) throw new SettingsInputError("当前目录中没有可集成的 Codex 模型。");
  }
  await updateProvider(name, { codexDesktop: enabled });
}

async function readDesktopConfig(file: string) {
  try {
    if (!(await fs.lstat(file)).isFile()) throw new SettingsInputError("Codex 配置必须是常规文件。");
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function setDesktopGatewayConfig(secret?: string) {
  const file = path.join(codexHome(), "config.toml");
  const block = secret && [
    `[model_providers.${desktopProviderId}]`, 'name = "AxiomRuntime"', 'wire_api = "responses"',
    `base_url = "${desktopOrigin}/v1"`, `model_catalog_url = "${desktopOrigin}/v1/models"`,
    "requires_openai_auth = true", "supports_websockets = false", "request_max_retries = 0", "stream_max_retries = 0",
    `http_headers = { X-Axiom-Desktop = "${secret}" }`
  ].join("\n");
  await withJsonFileLock(file, async () => {
    const original = await readDesktopConfig(file);
    if (original === undefined) {
      if (!block) return;
      throw new SettingsInputError("未找到 Codex 配置。请先打开桌面端并完成账号登录。");
    }
    const config = parse(original);
    const providerId = config.model_provider ?? "openai";
    let withGateway = original;
    if (block) {
      if (providerId !== "openai" && providerId !== desktopProviderId) throw new SettingsInputError("当前使用其他自定义 Codex Provider；请先切回原生 ChatGPT Provider，未修改配置。");
      if (config.model_catalog_json) throw new SettingsInputError("已有 model_catalog_json 会覆盖网关目录；未修改配置。");
      const registered = (config.model_providers as Record<string, unknown> | undefined)?.[desktopProviderId];
      const entry = (parse(block).model_providers as Record<string, unknown>)[desktopProviderId];
      if (registered !== undefined && !isDeepStrictEqual(registered, entry)) throw new SettingsInputError("已有同名提供商，未覆盖。");
      if (registered === undefined) withGateway += "\n" + block + "\n";
      else if (providerId === desktopProviderId) return;
    } else if (providerId !== desktopProviderId) return;
    const target = block ? desktopProviderId : "openai";
    const next = setTopLevelTomlString(withGateway, "model_provider", target);
    const expected = parse(withGateway);
    expected.model_provider = target;
    if (!isDeepStrictEqual(parse(next), expected)) throw new SettingsInputError("无法安全更新 Codex 的默认提供商，已保留现有配置。");
    await fs.mkdir(desktopDir(), { recursive: true, mode: 0o700 });
    const backup = await fs.mkdtemp(path.join(desktopDir(), "recovery-"));
    await fs.writeFile(path.join(backup, "config.toml"), original, { mode: 0o600 });
    const digest = createHash("sha256").update(original).digest("hex");
    await fs.writeFile(path.join(backup, "恢复 Codex.command"),
      '#!/bin/bash\nset -eu\numask 077\ncd -- "$(dirname -- "$0")"\n' +
      "target=" + "'" + file.replaceAll("'", "'\\''") + "'\n" +
      `printf '%s  config.toml\\n' '${digest}' | /usr/bin/shasum -a 256 -c - || exit 1\n` +
      '[[ ! -L "$target" && ( ! -e "$target" || -f "$target" ) ]] || exit 1\ntemp=$(mktemp "${target}.restore.XXXXXX")\n' +
      'cp config.toml "$temp" && cmp -s config.toml "$temp"\n' +
      'if [[ -f "$target" ]]; then cp "$target" "$(mktemp ./before-restore.XXXXXX)"; fi\n' +
      'mv -f "$temp" "$target"\necho "已恢复配置，请重新打开 Codex。"\n', { mode: 0o700 });
    await atomicWriteFile(file, next, 0o600);
  });
}
