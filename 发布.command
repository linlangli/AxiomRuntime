#!/bin/zsh

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22.19.0 或更高版本。"
  /usr/bin/open "https://nodejs.org/zh-cn/download" >/dev/null 2>&1 || true
  echo ""
  read "REPLY?按回车键关闭..."
  exit 1
fi

node scripts/release.js
STATUS=$?

echo ""
read "REPLY?按回车键关闭..."
exit $STATUS
