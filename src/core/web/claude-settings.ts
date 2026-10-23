import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listProviders } from "../providers/provider-service.js";
import { readJsonFile, updateJsonFile } from "../config/json-store.js";
import { SettingsInputError } from "../config/service-exposure.js";
import { getToolBaseUrl } from "../runner/tool-runner.js";
import { writeLog } from "../logs/log-service.js";

function settingsPath() { return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json"); }

export async function getClaudeSettings() {
  const config = await readJsonFile<Record<string, unknown>>(settingsPath(), {});
  const env = config.env as Record<string, string> | undefined;
  return { path: settingsPath(), baseUrl: env?.ANTHROPIC_BASE_URL ?? "", model: env?.ANTHROPIC_MODEL ?? "", credentialConfigured: !!(env?.ANTHROPIC_API_KEY || env?.ANTHROPIC_AUTH_TOKEN) };
}

export async function applyClaudeSettings(input: Record<string, unknown>) {
  if (input.action !== undefined && input.action !== "provider" && input.action !== "clear") throw new SettingsInputError("Claude 配置操作无效。");
  const provider = (await listProviders()).find(item => item.name === input.provider);
  if (input.action !== "clear" && !provider) throw new SettingsInputError("请选择 Provider。");
  const file = settingsPath();
  const original = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (original !== null) await fs.writeFile(`${file}.axiom-backup-${Date.now()}`, original, { mode: 0o600 });
  await updateJsonFile<Record<string, unknown>>(file, {}, current => {
    if (!current || typeof current !== "object" || Array.isArray(current) || current.env !== undefined && (!current.env || typeof current.env !== "object" || Array.isArray(current.env))) throw new SettingsInputError("Claude settings.json 或 env 格式无效，请先修复原文件。");
    const env = { ...(current.env as Record<string, string> ?? {}) };
    for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"]) delete env[key];
    if (input.action !== "clear" && provider) Object.assign(env, { ANTHROPIC_BASE_URL: getToolBaseUrl("claude", provider), ANTHROPIC_API_KEY: provider.apiKey, ANTHROPIC_MODEL: typeof input.model === "string" && input.model.trim() ? input.model.trim() : provider.model });
    return { ...current, env };
  });
  await fs.chmod(file, 0o600);
  await writeLog({ category: "provider", action: "claude_settings_updated", message: "Claude user settings updated; restart Claude to apply." });
  return { effect: "Claude 用户配置已保存并保留原文件备份，重新启动 Claude Code 后生效。" };
}
