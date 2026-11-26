#!/bin/bash
set -eu
umask 077
[[ "$(uname -s)" == Darwin ]] || { echo '仅适用于 macOS'; exit 1; }
dir="${AI_GATEWAY_HOME:-$HOME/.ai-gateway}/codex-desktop"
mkdir -p "$dir"
cd "$dir"
if [[ ! -e localhost.pem && ! -e localhost-key.pem ]]; then
  temp=$(mktemp -d ./certificate.XXXXXXXX)
  trap 'rm -f "$temp/config" "$temp/cert" "$temp/key"; rmdir "$temp"' EXIT
  printf '%s\n' '[req]' 'distinguished_name=dn' 'prompt=no' 'x509_extensions=leaf' '[dn]' 'CN=AxiomRuntime Codex Loopback' '[leaf]' 'subjectAltName=IP:127.0.0.1' 'basicConstraints=critical,CA:FALSE' 'extendedKeyUsage=serverAuth' 'keyUsage=critical,digitalSignature,keyEncipherment' > "$temp/config"
  /usr/bin/openssl req -new -x509 -newkey rsa:2048 -sha256 -nodes -days 180 -config "$temp/config" -keyout "$temp/key" -out "$temp/cert"
  mv "$temp/key" localhost-key.pem
  mv "$temp/cert" localhost.pem
fi
[[ -f localhost.pem && -f localhost-key.pem ]] || { echo '证书文件不完整，未覆盖。'; exit 1; }
/usr/bin/openssl x509 -in localhost.pem -noout -subject -enddate -fingerprint -sha256
echo '下一步只信任这张本机 HTTPS 证书（127.0.0.1）。不会读取或修改 ChatGPT 登录。'
read -r -p '确认写入当前用户的 macOS 信任设置？输入 yes：' answer
[[ "$answer" == yes ]] || exit 1
/usr/bin/security add-trusted-cert -r trustRoot -p ssl -s 127.0.0.1 -k "$HOME/Library/Keychains/login.keychain-db" localhost.pem
echo '已配置本机 HTTPS。可回到 AxiomRuntime 打开集成开关。'
