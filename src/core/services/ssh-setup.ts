import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "ssh2";
import { getConfigRoot } from "../config/paths.js";
import { withJsonFileLock } from "../config/json-store.js";
import { SettingsInputError } from "../config/service-exposure.js";
import { loadSshTunnel, sshTunnelArgs, validateSshTunnel } from "./ssh-tunnel.js";

export async function runSshCommand(command: string, args: string[], input = "", timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" }, windowsHide: true });
    const chunks: Buffer[] = []; let length = 0; let diagnostic = "";
    const timer = setTimeout(() => { child.kill(); reject(new SettingsInputError("操作超时，请检查网络、权限与服务端日志。")); }, timeout);
    child.stdout.on("data", chunk => { length += chunk.length; if (length > 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.stderr.on("data", chunk => { if (diagnostic.length < 2000) diagnostic += String(chunk).slice(0, 2000 - diagnostic.length); });
    child.stdin.on("error", () => undefined);
    child.on("error", () => { clearTimeout(timer); reject(new SettingsInputError("无法启动系统 OpenSSH/远程操作，请确认依赖已安装。")); });
    child.on("close", code => { clearTimeout(timer); code === 0 && length <= 1024 * 1024 ? resolve(Buffer.concat(chunks).toString()) : reject(new SettingsInputError(`SSH/远程操作失败，操作可能已部分执行。${diagnostic.trim()}`)); });
    child.stdin.end(input);
  });
}

const scans = new Map<string, { keys: string; host: string; port: number; expires: number }>();

export async function prepareSsh(input: Record<string, unknown>, dependencies: { home?: string; run?: typeof runSshCommand } = {}) {
  const run = dependencies.run ?? runSshCommand;
  const raw = input.config ?? await loadSshTunnel();
  const config = validateSshTunnel(input.action === "keygen" && raw && typeof raw === "object" ? { ...raw, identityFile: path.join(getConfigRoot(), "service-ssh-key") } : raw);
  const directory = path.join(dependencies.home ?? os.homedir(), ".ssh");
  const known = path.join(directory, "known_hosts");
  if (input.action === "scan") {
    for (const [id, value] of scans) if (value.expires < Date.now()) scans.delete(id);
    if (scans.size >= 20) throw new SettingsInputError("待确认指纹过多，请稍后再试。");
    const output = await run("ssh-keyscan", ["-T", "5", "-p", String(config.port), "-t", "ed25519,rsa", config.host]);
    const host = config.port === 22 ? config.host : `[${config.host}]:${config.port}`;
    const keys = output.split("\n").filter(line => line.startsWith(`${host} `) && /^[^\s]+ ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]+$/.test(line)).join("\n") + "\n";
    if (!keys.trim()) throw new SettingsInputError("服务器未返回有效主机公钥。");
    const fingerprints = await run("ssh-keygen", ["-lf", "-"], keys);
    const id = crypto.randomUUID(); scans.set(id, { keys, host: config.host, port: config.port, expires: Date.now() + 600_000 });
    return { scanId: id, fingerprints, detail: "请从服务器控制台或管理员核对指纹，再点击信任。扫描结果本身不能证明服务器身份。" };
  }
  if (input.action === "trust") {
    const scan = scans.get(String(input.scanId));
    if (!scan || scan.expires < Date.now() || scan.host !== config.host || scan.port !== config.port) throw new SettingsInputError("指纹确认已过期或服务器已改变，请重新扫描。");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await withJsonFileLock(known, async () => {
      const existing = await fs.readFile(known, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      {
        const host = config.port === 22 ? config.host : `[${config.host}]:${config.port}`;
        const matches = await run("ssh-keygen", ["-F", host, "-f", known]).catch(() => "");
        if (matches && !matches.split("\n").filter(line => line && !line.startsWith("#")).every(line => scan.keys.includes(line.split(" ").slice(1).join(" ")))) throw new SettingsInputError("已有主机密钥与扫描结果冲突，拒绝覆盖。请先通过服务器控制台确认变更。");
        await fs.writeFile(known, existing + (existing.endsWith("\n") || !existing ? "" : "\n") + scan.keys, { mode: 0o600 });
        await fs.chmod(known, 0o600);
      }
    });
    scans.delete(String(input.scanId));
    return { detail: "主机指纹已保存，后续仍执行严格校验。" };
  }
  if (input.action === "keygen") {
    const identityFile = path.join(getConfigRoot(), "service-ssh-key");
    await fs.mkdir(getConfigRoot(), { recursive: true, mode: 0o700 });
    await withJsonFileLock(`${identityFile}.generation`, async () => {
      if (!await fs.stat(identityFile).catch(() => null)) await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identityFile]);
    });
    return { identityFile, publicKey: await fs.readFile(`${identityFile}.pub`, "utf8"), detail: "专用密钥已在本机生成。私钥不回传；请授权公钥到服务器。" };
  }
  if (input.action === "diagnose") {
    const key = await fs.stat(config.identityFile).catch(() => null);
    const checks = [{ name: "私钥文件", ok: !!key?.isFile(), detail: key?.isFile() ? "文件存在" : "文件不存在" }];
    if (key) checks.push({ name: "密钥权限", ok: process.platform === "win32" || (key.mode & 0o077) === 0, detail: process.platform === "win32" ? "Windows 请确保文件 ACL 仅授权当前用户" : (key.mode & 0o077) === 0 ? "仅当前用户可读" : "请将密钥权限设置为 600" });
    try { await run("ssh", [...sshTunnelArgs(config), config.host, "true"]); checks.push({ name: "SSH 认证", ok: true, detail: "严格主机校验与非交互公钥认证通过" }); }
    catch { checks.push({ name: "SSH 认证", ok: false, detail: "检查已信任指纹、公钥授权、私钥口令/代理、用户名和端口" }); }
    return { checks, detail: "诊断不修改远端配置。下一步连接隧道并验证 18080 转发端口。" };
  }
  if (input.action === "authorize") {
    if (typeof input.password !== "string" || !input.password || input.password.length > 1024) throw new SettingsInputError("请输入服务器账户密码，仅用于本次公钥授权，不保存。");
    const host = config.port === 22 ? config.host : `[${config.host}]:${config.port}`;
    const trusted = await run("ssh-keygen", ["-F", host, "-f", known]);
    const hashes = trusted.split("\n").filter(line => line && !line.startsWith("#")).map(line => crypto.createHash("sha256").update(Buffer.from(line.split(/\s+/)[2] ?? "", "base64")).digest("hex"));
    if (!hashes.length) throw new SettingsInputError("请先核对并信任服务器主机指纹。");
    const publicKey = (await fs.readFile(path.join(getConfigRoot(), "service-ssh-key.pub"), "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(publicKey)) throw new SettingsInputError("请先生成专用密钥。");
    await new Promise<void>((resolve, reject) => {
      const client = new Client();
      const timer = setTimeout(() => { client.destroy(); reject(new SettingsInputError("公钥授权超时。")); }, 20_000);
      const done = (error?: Error) => { clearTimeout(timer); client.end(); error ? reject(new SettingsInputError("公钥授权失败，请检查账户密码和服务器 SSH 密码登录策略。")) : resolve(); };
      client.on("error", done);
      client.on("ready", () => client.exec(`umask 077; mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys" && { grep -qxF '${publicKey}' "$HOME/.ssh/authorized_keys" || printf '%s\\n' '${publicKey}' >> "$HOME/.ssh/authorized_keys"; }`, (error, stream) => {
        if (error) { done(error); return; }
        stream.on("data", () => undefined); stream.stderr.on("data", () => undefined);
        stream.on("close", (code: number) => done(code === 0 ? undefined : new Error("Authorization failed")));
      }));
      client.connect({ host: config.host, port: config.port, username: config.user, password: input.password as string, hostHash: "sha256", hostVerifier: (hash: string) => hashes.includes(hash), readyTimeout: 10_000, tryKeyboard: false });
    });
    return { detail: "专用公钥已授权。请保存密钥路径、执行诊断，再连接隧道。" };
  }
  throw new SettingsInputError("未知 SSH 准备操作。");
}
