import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { getConfigRoot } from "../config/paths.js";
import { readJsonFile, writeJsonFile, withJsonFileLock } from "../config/json-store.js";
import { loadServiceExposure, SettingsInputError } from "../config/service-exposure.js";
import { createApiServiceManager, type ApiServiceAction, type ServiceDependencies } from "./api-service.js";
import { writeLog } from "../logs/log-service.js";

const execute = promisify(execFile);
export type SshTunnelConfig = { host: string; user: string; port: number; identityFile: string };
export const TUNNEL_UPSTREAM = "http://127.0.0.1:18080";

export function validateSshTunnel(value: unknown): SshTunnelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsInputError("请输入 SSH 连接配置。");
  const input = value as Record<string, unknown>;
  if (typeof input.host !== "string" || input.host.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(input.host)) throw new SettingsInputError("SSH 主机须为 IPv4 或域名，不含用户名、端口或命令。");
  if (typeof input.user !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(input.user)) throw new SettingsInputError("请输入有效 SSH 用户名。");
  if (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535) throw new SettingsInputError("SSH 端口须为 1–65535。");
  if (typeof input.identityFile !== "string" || !path.isAbsolute(input.identityFile) || /[\r\n\0]/.test(input.identityFile)) throw new SettingsInputError("请选择本机 SSH 私钥的绝对路径。");
  return { host: input.host, user: input.user, port: Number(input.port), identityFile: input.identityFile };
}

export function loadSshTunnel(): Promise<SshTunnelConfig | null> {
  return readJsonFile(path.join(getConfigRoot(), "ssh-tunnel.json"), null);
}

export function tunnelSocket(): string {
  return path.join(os.tmpdir(), `axiom-ssh-${process.getuid?.() ?? "user"}-${crypto.createHash("sha256").update(getConfigRoot()).digest("hex").slice(0, 16)}.sock`);
}

export function sshTunnelArgs(config: SshTunnelConfig): string[] {
  return ["-F", os.devNull, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes", "-o", "PermitLocalCommand=no", "-o", "ForwardAgent=no", "-i", config.identityFile, "-p", String(config.port), "-l", config.user];
}

export function managedTunnelArgs(config: SshTunnelConfig): string[] {
  if (process.platform === "win32") return [...sshTunnelArgs(config), "-N", "-R", "127.0.0.1:18080:127.0.0.1:8080", config.host];
  return [...sshTunnelArgs(config), "-M", "-S", tunnelSocket(), "-o", "ControlPersist=no", "-N", "-R", "127.0.0.1:18080:127.0.0.1:8080", config.host];
}

async function checkedConfig() {
  const config = validateSshTunnel(await loadSshTunnel());
  const stat = await fs.stat(config.identityFile).catch(() => null);
  if (!stat?.isFile()) throw new SettingsInputError("SSH 私钥文件不存在，请填写运行 Runtime 的电脑上的密钥路径。");
  return config;
}

export function createSshTunnelManager(dependencies: ServiceDependencies = {}) {
  const service = createApiServiceManager({ ...dependencies, kind: "tunnel", beforeStart: async () => {
    if ((await loadServiceExposure()).connectionMode !== "ssh") throw new SettingsInputError("请先保存 SSH 隧道接入模式。");
    await checkedConfig();
    const api = await createApiServiceManager(dependencies).status();
    if (!api.running) throw new SettingsInputError("请先启动本机 API 服务，再连接 SSH 隧道。");
  } });
  const run = dependencies.run ?? (async (command: string, args: string[]) => (await execute(command, args, { timeout: 15_000, maxBuffer: 128 * 1024 })).stdout);
  async function status() {
    const state = await service.status();
    const config = await loadSshTunnel();
    let connected = false;
    if (state.running && config) {
      try { await run("ssh", [...sshTunnelArgs(validateSshTunnel(config)), ...(process.platform === "win32" ? [config.host, "true"] : ["-S", tunnelSocket(), "-O", "check", config.host])]); connected = true; } catch {}
    }
    return { ...state, config, connected, upstreamUrl: TUNNEL_UPSTREAM, detail: connected ? "SSH 认证检查通过；请验证服务器转发端口" : state.running ? "隧道进程运行中，SSH 尚未确认连接；请刷新或检查日志" : state.detail };
  }
  async function save(value: unknown) {
    const config = validateSshTunnel(value);
    return withJsonFileLock(path.join(getConfigRoot(), "tunnel-service-control"), async () => {
      const state = await service.status();
      if (state.running || state.autostart) throw new SettingsInputError("请先停止隧道并关闭自启，再修改服务器配置。");
      await writeJsonFile(path.join(getConfigRoot(), "ssh-tunnel.json"), config);
      await writeLog({ category: "provider", action: "ssh_tunnel_configured", message: "SSH tunnel connection configured." });
      return status();
    });
  }
  async function test() {
    const state = await status();
    if (!state.connected || !state.config) throw new SettingsInputError("隧道尚未连接，无法验证服务器端口。");
    try {
      const output = await run("ssh", [...sshTunnelArgs(state.config), ...(process.platform === "win32" ? [] : ["-S", tunnelSocket(), "-o", "ControlMaster=no"]), state.config.host, "curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18080/health/live"]);
      return { ok: JSON.parse(output).status === "ok", detail: "已从服务器检查隧道端口；仍需用调用凭证验证实际能力。" };
    } catch { throw new SettingsInputError("服务器端口验证失败。检查 SSH 转发权限、18080 端口冲突、服务器 curl 及本机 API 状态。"); }
  }
  return { status, save, test, control: async (action: ApiServiceAction) => { await service.control(action); return status(); } };
}
