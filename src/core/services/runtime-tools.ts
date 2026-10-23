import { listProviders } from "../providers/provider-service.js";

export const RUNTIME_TOOLS = [
  { name: "runtime.status", description: "查询 Runtime 配置状态（不返回密钥）" },
  { name: "providers.list", description: "列出 Provider 名称和默认模型（不返回密钥）" }
];

export async function executeRuntimeTool(name: unknown, providers?: string[], models?: string[]) {
  const items = (await listProviders()).filter(item => (!providers?.length || providers.includes(item.name)) && (!models?.length || models.includes(item.model)));
  if (name === "runtime.status") return { configuredProviders: items.length, node: process.version, platform: process.platform };
  if (name === "providers.list") return items.map(item => ({ name: item.name, model: item.model, level: item.level }));
  throw new Error("未知工具；只允许 runtime.status 或 providers.list，不执行任意命令。");
}
