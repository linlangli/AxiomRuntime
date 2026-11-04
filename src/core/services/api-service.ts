import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getConfigRoot } from "../config/paths.js";
import { withJsonFileLock } from "../config/json-store.js";
import { loadServiceExposure, SettingsInputError } from "../config/service-exposure.js";
import { writeLog } from "../logs/log-service.js";
import { windowsTaskManager } from "./windows-service.js";

const execute = promisify(execFile);
export type ApiServiceAction = "start" | "stop" | "restart" | "enable" | "disable";
export type ApiServiceStatus = { supported: boolean; running: boolean; autostart: boolean; installed: boolean; manager: string; logPath: string; baseUrl: string; detail: string };
export type ServiceDependencies = { platform?: string; home?: string; run?: (command: string, args: string[]) => Promise<string>; kind?: "api" | "tunnel"; beforeStart?: () => Promise<void> };

export function renderApiService(platform: string, input: { label: string; node: string; entry: string; root: string; log: string; autostart: boolean }): string {
  if ([input.node, input.entry, input.root, input.log].some(value => /[\r\n\0]/.test(value))) throw new Error("Invalid service path.");
  if (platform === "darwin") {
    const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${input.label}</string><key>ProgramArguments</key><array><string>${xml(input.node)}</string><string>${xml(input.entry)}</string></array><key>WorkingDirectory</key><string>${xml(input.root)}</string><key>EnvironmentVariables</key><dict><key>AI_GATEWAY_HOME</key><string>${xml(input.root)}</string><key>AXIOM_MANAGED_API</key><string>1</string></dict><key>RunAtLoad</key><${input.autostart ? "true" : "false"}/><key>KeepAlive</key><dict><key>AfterInitialDemand</key><true/><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(input.log)}</string><key>StandardErrorPath</key><string>${xml(input.log)}</string></dict></plist>`;
  }
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  const executable = (value: string) => quote(value.replace(/\$/g, "$$"));
  return `[Unit]\nDescription=AxiomRuntime API\nAfter=network.target\n[Service]\nType=simple\nExecStart=${executable(input.node)} ${executable(input.entry)}\nWorkingDirectory=${quote(input.root)}\nEnvironment=${quote(`AI_GATEWAY_HOME=${input.root}`)}\nEnvironment=AXIOM_MANAGED_API=1\nRestart=on-failure\nRestartSec=10\nUMask=0077\n[Install]\nWantedBy=default.target\n`;
}

export function createApiServiceManager(dependencies: ServiceDependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const home = dependencies.home ?? os.homedir();
  const supported = platform === "darwin" || platform === "linux" || platform === "win32";
  const run = dependencies.run ?? (async (command: string, args: string[]) => {
    try { return (await execute(command, args, { timeout: 15_000, maxBuffer: 256 * 1024 })).stdout; }
    catch { throw new Error(`${command} ${args[0]} failed. Check the user service manager and service logs.`); }
  });
  const root = getConfigRoot();
  const kind = dependencies.kind ?? "api";
  const label = `life.offerpilot.axiom-${kind}-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
  const windows = windowsTaskManager({ label, root, kind, run });
  const unit = `${label}.service`;
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const file = platform === "darwin" ? path.join(home, "Library/LaunchAgents", `${label}.plist`) : path.join(home, ".config/systemd/user", unit);
  const logPath = platform === "darwin" ? path.join(root, `${kind}-service.log`) : `journalctl --user -u ${unit}`;
  const exists = async () => fs.access(file).then(() => true, () => false);
  const command = (args: string[]) => platform === "darwin" ? run("/bin/launchctl", args) : run("systemctl", ["--user", ...args]);
  async function status(): Promise<ApiServiceStatus> {
    if (platform === "win32") return windows.status();
    const installed = await exists();
    let running = false;
    let autostart = false;
    let detail = supported ? "服务未启动" : "当前平台不支持后台 API 服务";
    if (installed && supported) {
      if (platform === "darwin") autostart = (await fs.readFile(file, "utf8")).includes("<key>RunAtLoad</key><true/>");
      try {
        const output = await command(platform === "darwin" ? ["print", `${domain}/${label}`] : ["show", unit, "--property=ActiveState,UnitFileState"]);
        running = platform === "darwin" ? /state = running/.test(output) : /ActiveState=active/.test(output);
        if (platform === "linux") autostart = /UnitFileState=enabled/.test(output);
        detail = running ? "服务运行中" : "服务已安装但未运行；请检查日志";
      } catch { detail = "无法查询用户服务管理器；请确认登录会话或 systemd --user 可用"; }
    }
    return { supported, installed, running, autostart, manager: platform === "darwin" ? "launchd" : platform === "linux" ? "systemd --user" : "unsupported", logPath, baseUrl: "http://127.0.0.1:8080", detail };
  }
  async function install(autostart: boolean) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(file, renderApiService(platform, { label, node: process.execPath, entry: fileURLToPath(new URL(kind === "api" ? "../../server/index.js" : "../../server/ssh-tunnel.js", import.meta.url)), root, log: logPath, autostart }), { mode: 0o600 });
    await fs.chmod(file, 0o600);
    if (platform === "linux") await command(["daemon-reload"]);
  }
  async function control(action: ApiServiceAction): Promise<ApiServiceStatus> {
    if (!supported) throw new SettingsInputError("当前平台不支持后台服务，请使用前台 API 启动方式。");
    if (!["start", "stop", "restart", "enable", "disable"].includes(action)) throw new SettingsInputError("未知 API 服务操作。");
    const before = await status();
    if (["start", "restart", "enable"].includes(action)) {
      const exposure = await loadServiceExposure();
      if (!exposure.capabilities.length || !exposure.credentials.some(item => (!item.policy?.expiresAt || Date.parse(item.policy.expiresAt) > Date.now()) && item.capabilities.some(capability => exposure.capabilities.includes(capability)))) throw new SettingsInputError("请先保存开放能力并创建有效调用凭证。");
      await dependencies.beforeStart?.();
    }
    if (platform === "win32") {
      const result = await windows.control(action);
      await writeLog({ category: "provider", action: "api_service_control", message: `${kind} service: ${action}.`, metadata: { manager: platform, action, kind } });
      return result;
    }
    if (action === "stop" || action === "disable") {
      if (before.installed) {
        if (platform === "darwin") {
          if (action === "stop") await command(["bootout", `${domain}/${label}`]).catch(error => { if (before.running) throw error; });
          await install(false);
        } else {
          await command(["disable", ...(action === "stop" ? ["--now"] : []), unit]);
        }
      }
    } else {
      if (platform === "darwin") {
        if (before.running && action === "start") return before;
        if (before.installed) await command(["bootout", `${domain}/${label}`]).catch(() => undefined);
        await install(action === "enable" || before.autostart);
        await command(["bootstrap", domain, file]);
        await command(["kickstart", `${domain}/${label}`]);
      } else {
        await install(action === "enable" || before.autostart);
        if (action === "enable") await command(["enable", unit]);
        await command([action === "restart" ? "restart" : "start", unit]);
      }
    }
    await writeLog({ category: "provider", action: "api_service_control", message: `${kind} service: ${action}.`, metadata: { manager: platform, action, kind } });
    return status();
  }
  return { status, control: (action: ApiServiceAction) => withJsonFileLock(path.join(root, `${kind}-service-control`), async () => {
    try { return await control(action); }
    catch (error) {
      await writeLog({ level: "error", category: "error", action: "api_service_control_failed", message: "API service manager operation failed.", metadata: { action, platform } });
      if (error instanceof SettingsInputError) throw error;
      throw new SettingsInputError(`API 服务操作失败。请检查 ${platform === "darwin" ? "launchd 用户登录会话" : platform === "win32" ? "Windows 任务计划程序" : "systemd --user / linger 配置"}，以及 ${logPath}。`);
    }
  }) };
}
