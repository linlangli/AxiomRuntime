import crypto from "node:crypto";
import { loadServiceExposure, SettingsInputError } from "../config/service-exposure.js";
import { loadSshTunnel, sshTunnelArgs, validateSshTunnel } from "./ssh-tunnel.js";
import { runSshCommand } from "./ssh-setup.js";
import { getConfigRoot } from "../config/paths.js";
import { writeLog } from "../logs/log-service.js";

export async function deploymentPlan(email: unknown, install: unknown) {
  const config = await loadServiceExposure();
  const ssh = validateSshTunnel(await loadSshTunnel());
  if (!config.publicBaseUrl || !config.capabilities.length) throw new SettingsInputError("请先保存公网 HTTPS 入口与开放能力。");
  const url = new URL(config.publicBaseUrl);
  if (url.port && url.port !== "443" || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) || !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname)) throw new SettingsInputError("自动证书部署需要有效域名与标准 HTTPS 443 端口。");
  if (typeof email !== "string" || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) || email.length > 200) throw new SettingsInputError("请输入有效证书联系邮箱。");
  if (config.connectionMode === "local") throw new SettingsInputError("同机部署请将生成配置交给本机管理员；远程自动部署需要 SSH 接入模式。");
  const { SERVICE_CAPABILITIES } = await import("../config/service-exposure.js");
  const locations = SERVICE_CAPABILITIES.filter(item => config.capabilities.includes(item.id)).map(item => `location = ${item.path} { proxy_pass http://127.0.0.1:18080; proxy_http_version 1.1; proxy_set_header Authorization $http_authorization; proxy_set_header X-Request-ID $request_id; proxy_buffering off; proxy_read_timeout 600s; client_max_body_size 58m; }`).join("\n");
  const domain = url.hostname.toLowerCase();
  const owner = crypto.createHash("sha256").update(getConfigRoot()).digest("hex").slice(0, 16);
  const httpConfig = `server { listen 80; server_name ${domain}; location ^~ /.well-known/acme-challenge/ { root /var/lib/axiom-acme; } location / { return 404; } }`;
  const tlsConfig = `${httpConfig}\nserver { listen 443 ssl; server_name ${domain}; ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem; ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem; ssl_protocols TLSv1.2 TLSv1.3; ${locations}\nlocation = /health/live { proxy_pass http://127.0.0.1:18080; } location / { return 404; } }`;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const script = `set -eu
test "$(id -u)" = 0 || { printf '%s\\n' 'Root SSH account is required for automatic deployment.'; exit 1; }
command -v flock >/dev/null
exec 9>/var/lock/axiom-runtime-deploy.lock
flock -n 9
${install === true ? "if ! command -v nginx >/dev/null || ! command -v certbot >/dev/null; then if command -v apt-get >/dev/null; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot; elif command -v dnf >/dev/null; then dnf install -y nginx certbot; else exit 1; fi; fi" : "command -v nginx >/dev/null; command -v certbot >/dev/null"}
command -v systemctl >/dev/null
domain=${quote(domain)}
destination="/etc/nginx/conf.d/axiom-runtime-$domain.conf"
marker="$destination.axiom-owner"
nginx -t
if test -e "$destination"; then test "$(cat "$marker" 2>/dev/null)" = ${quote(owner)} || exit 1; else active_config=$(nginx -T 2>&1); if printf '%s\\n' "$active_config" | awk -v domain="$domain" '{ sub(/#.*/, ""); gsub(/[{};]/, " & "); for (fieldIndex = 1; fieldIndex <= NF; fieldIndex++) { if ($fieldIndex == "server_name") { inNames = 1; continue } if (inNames && $fieldIndex == ";") inNames = 0; else if (inNames && $fieldIndex == domain) found = 1 } } END { exit !found }'; then exit 1; fi; fi
mkdir -p /etc/nginx/conf.d /var/lib/axiom-acme
temporary=$(mktemp -d)
had_previous=0
if test -f "$destination"; then cp -p "$destination" "$temporary/previous"; had_previous=1; fi
committed=0
cleanup() { if test "$committed" = 0; then if test "$had_previous" = 1; then cp -p "$temporary/previous" "$destination"; else rm -f "$destination" "$marker"; fi; nginx -t && systemctl reload nginx || true; fi; rm -rf "$temporary"; }
trap cleanup EXIT
printf '%s\\n' ${quote(httpConfig)} > "$destination"
printf '%s\\n' ${quote(owner)} > "$marker"
nginx -t
systemctl start nginx
systemctl reload nginx
certbot certonly --webroot -w /var/lib/axiom-acme -d "$domain" --email ${quote(email)} --agree-tos --non-interactive --keep-until-expiring
printf '%s\\n' ${quote(tlsConfig)} > "$destination"
nginx -t
systemctl reload nginx
renewal_timer=
for candidate in certbot.timer certbot-renew.timer; do if systemctl list-unit-files "$candidate" --no-legend | grep -q "^$candidate "; then renewal_timer="$candidate"; break; fi; done
test -n "$renewal_timer" || { printf '%s\\n' 'Certbot renewal timer is missing.'; exit 1; }
systemctl enable "$renewal_timer"
systemctl start "$renewal_timer"
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '%s\\n' '#!/bin/sh' 'nginx -t && systemctl reload nginx' > /etc/letsencrypt/renewal-hooks/deploy/axiom-nginx-reload
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/axiom-nginx-reload
committed=1
printf '%s\\n' 'Nginx HTTPS deployment complete.'
`;
  return { host: ssh.host, domain, config: tlsConfig, script, effect: "将修改此域名的专属 Nginx 配置并申请证书；失败恢复原 Nginx 配置。软件包、已签发证书及 ACME 账户不自动卸载。域名 A 记录须指向服务器，80/443 须可访问。" };
}

const plans = new Map<string, { script: string; ssh: string; expires: number }>();
export async function previewDeployment(input: Record<string, unknown>) {
  for (const [id, plan] of plans) if (plan.expires < Date.now()) plans.delete(id);
  if (plans.size >= 10) throw new SettingsInputError("待执行部署过多，请稍后再试。");
  const plan = await deploymentPlan(input.email, input.installDependencies);
  const id = crypto.randomUUID(); plans.set(id, { script: plan.script, ssh: JSON.stringify(await loadSshTunnel()), expires: Date.now() + 600_000 });
  return { ...plan, planId: id };
}

export async function executeDeployment(input: Record<string, unknown>) {
  const plan = plans.get(String(input.planId));
  const current = await deploymentPlan(input.email, input.installDependencies);
  if (!plan || plan.expires < Date.now() || plan.script !== current.script || plan.ssh !== JSON.stringify(await loadSshTunnel())) throw new SettingsInputError("部署预览过期或配置已变化，请重新预览。");
  plans.delete(String(input.planId));
  const ssh = validateSshTunnel(await loadSshTunnel());
  await writeLog({ category: "provider", action: "web_remote_deploy_started", message: "Remote Nginx deployment requested.", metadata: { host: ssh.host, domain: current.domain } });
  try {
    const output = await runSshCommand("ssh", [...sshTunnelArgs(ssh), ssh.host, "sh -s"], plan.script, 180_000);
    return { output, effect: "HTTPS 站点已部署。请继续发送公网授权请求完成验收。" };
  } catch {
    throw new SettingsInputError("部署失败或超时。已设置 Nginx 配置回滚；请检查服务器 nginx -t、journalctl 与 certbot 日志，确认实际状态后重试。软件包和证书可能已创建。");
  }
}
