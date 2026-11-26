import { readProviders } from "../../core/config/providers-store.js";
import { disableDesktopGateway, getDesktopGatewayStatus, registerDesktopGateway, setDesktopGatewayProvider } from "../../core/integrations/codex-desktop.js";
import { startDesktopTransport } from "../../server/codex-desktop.js";
import { promptSelect } from "../prompts/prompt.js";

const usage = "Usage: ai codex-gateway [start|off|status|provider <list|on <name>|off <name>>]";

export async function runCodexGatewayCommand(args: string[]) {
  if (!args.length) {
    if (!process.stdin.isTTY) throw new Error(usage);
    const action = await promptSelect("Codex 统一网关", [
      { label: "启动并启用统一网关", value: "start" },
      { label: "关闭网关，切回原生", value: "off" },
      { label: "查看状态", value: "status" },
      { label: "管理第三方 Provider", value: "provider" },
      { label: "返回", value: "cancel" }
    ]);
    if (action === "cancel") return;
    if (action !== "provider") return runCodexGatewayCommand([action]);
    const providers = await readProviders();
    if (!providers.length) { console.log("尚未配置 Provider。"); return; }
    const name = await promptSelect("选择 Provider，切换其网关接入状态", providers.map(provider => ({ label: `${provider.name} · ${provider.codexDesktop ? "已接入" : "未接入"}`, value: provider.name })));
    return runCodexGatewayCommand(["provider", providers.find(provider => provider.name === name)?.codexDesktop ? "off" : "on", name]);
  }

  const [action, subcommand, name] = args;
  if (action === "status" && args.length === 1) {
    const { enabled, providerId } = await getDesktopGatewayStatus();
    console.log(`Codex 已保存的路由：${enabled ? "统一网关" : providerId === "openai" ? "原生 OpenAI" : providerId}（不代表桌面已重载或网关进程在线）`);
    return;
  }
  if (action === "off" && args.length === 1) {
    await disableDesktopGateway();
    console.log("统一网关已关闭；其他自定义 Provider 不变。请完全退出并重开 Codex，再新建聊天。");
    return;
  }
  if (action === "provider" && subcommand === "list" && args.length === 2) {
    for (const provider of await readProviders()) console.log(`${provider.name}\t${provider.codexDesktop ? "已接入" : "未接入"}`);
    return;
  }
  if (action === "provider" && (subcommand === "on" || subcommand === "off") && name && args.length === 3) {
    await setDesktopGatewayProvider(name, subcommand === "on");
    console.log(`${name}：${subcommand === "on" ? "已接入" : "已移除"}；不改变 Codex 的默认路由。`);
    return;
  }
  if (action !== "start" || args.length !== 1) throw new Error(usage);

  const transport = await startDesktopTransport();
  try {
    await registerDesktopGateway(transport.secret);
    console.log("统一网关已启用。请完全退出并重开 Codex，再新建聊天。");
    if (!transport.owned) { console.log("正在复用已运行的本机网关。"); return; }
    console.log("保持本命令运行。退出前在另一终端执行 `ai codex-gateway off` 可切回原生。");
    await new Promise<void>(resolve => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    transport.close();
  }
}
