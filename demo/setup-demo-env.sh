#!/usr/bin/env bash
# Build a throwaway AxiomRuntime home for screen recordings.
#
# Everything lives under /tmp/axiom-demo so no real provider, API key, server IP
# or usage history can leak into a recording. Providers point at local mock
# upstreams started by this script:
#   demo-fast   level 1  -> broken  (drives the fallback demo)
#   demo-main   level 2  -> healthy
#   demo-backup level 3  -> healthy
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_HOME="${DEMO_HOME:-/tmp/axiom-demo}"
PORT_FAST=4801
PORT_MAIN=4802
PORT_BACKUP=4803

stop_mocks() {
  for port in "$PORT_FAST" "$PORT_MAIN" "$PORT_BACKUP"; do
    pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill 2>/dev/null || true
    fi
  done
}

if [ "${1:-}" = "stop" ]; then
  stop_mocks
  echo "mock upstreams stopped"
  exit 0
fi

stop_mocks
rm -rf "$DEMO_HOME"
mkdir -p "$DEMO_HOME"

node "$REPO_ROOT/demo/mock-upstream.mjs" "$PORT_FAST"   broken  >"$DEMO_HOME/mock-fast.log"   2>&1 &
node "$REPO_ROOT/demo/mock-upstream.mjs" "$PORT_MAIN"   healthy >"$DEMO_HOME/mock-main.log"   2>&1 &
node "$REPO_ROOT/demo/mock-upstream.mjs" "$PORT_BACKUP" healthy >"$DEMO_HOME/mock-backup.log" 2>&1 &

# Wait for the healthy mocks to accept connections.
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT_MAIN}/v1/models" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

cat >"$DEMO_HOME/providers.json" <<JSON
[
  {
    "name": "demo-fast",
    "baseUrl": "http://127.0.0.1:${PORT_FAST}/v1",
    "apiKey": "sk-demo-fast-0000000000000000",
    "mode": "auto",
    "level": 1,
    "model": "claude-opus-4-6"
  },
  {
    "name": "demo-main",
    "baseUrl": "http://127.0.0.1:${PORT_MAIN}/v1",
    "apiKey": "sk-demo-main-0000000000000000",
    "mode": "auto",
    "level": 2,
    "model": "claude-opus-4-6"
  },
  {
    "name": "demo-backup",
    "baseUrl": "http://127.0.0.1:${PORT_BACKUP}/v1",
    "apiKey": "sk-demo-backup-000000000000000",
    "mode": "ask",
    "level": 3,
    "model": "gpt-5.5-codex"
  }
]
JSON

# Seed usage so `ai status` shows a realistic share breakdown instead of zeros.
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$DEMO_HOME/usage.json" <<JSON
{
  "events": [
    { "provider": "demo-main", "tool": "claude", "model": "claude-opus-4-6", "source": "cli",
      "inputTokens": 184320, "outputTokens": 26880, "totalTokens": 211200, "createdAt": "${NOW}" },
    { "provider": "demo-main", "tool": "codex", "model": "gpt-5.5-codex", "source": "proxy",
      "inputTokens": 61440, "outputTokens": 12800, "totalTokens": 74240, "createdAt": "${NOW}" },
    { "provider": "demo-backup", "tool": "codex", "model": "gpt-5.5-codex", "source": "proxy",
      "inputTokens": 20480, "outputTokens": 5120, "totalTokens": 25600, "createdAt": "${NOW}" }
  ]
}
JSON

echo '{"providers":{}}' >"$DEMO_HOME/.ai-cache.json"
echo '{"sessions":[]}'  >"$DEMO_HOME/sessions.json"

# Neutral stub CLIs so `ai doctor` reports /tmp paths instead of /Users/<name>/...
# Recordings must never show the operator's home directory.
DEMO_BIN="$DEMO_HOME/bin"
mkdir -p "$DEMO_BIN"
for tool in claude codex; do
  printf '#!/bin/sh\nexit 0\n' >"$DEMO_BIN/$tool"
  chmod +x "$DEMO_BIN/$tool"
done

echo "demo home ready: $DEMO_HOME"
echo "run with: AI_GATEWAY_HOME=$DEMO_HOME node $REPO_ROOT/dist/cli/index.js status"
