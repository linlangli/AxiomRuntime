#!/usr/bin/env bash
set -euo pipefail

stream_config=/etc/nginx/stream.conf
route_anchor='        web.offerpilot.life     offerpilot_web_https;'
upstream_anchor='    upstream xray {'
route='        axiom.offerpilot.life   axiom_https;'
upstream='    upstream axiom_https {
        server 127.0.0.1:8450;
    }
'

if grep -Fq "$route" "$stream_config" && grep -Fq 'upstream axiom_https {' "$stream_config"; then
  echo 'AxiomRuntime SNI route already configured.'
  exit 0
fi

grep -Fq "$route_anchor" "$stream_config"
grep -Fq "$upstream_anchor" "$stream_config"
backup="${stream_config}.axiom-backup-20261010"
test ! -e "$backup"
cp -p "$stream_config" "$backup"
temporary=$(mktemp /etc/nginx/.axiom-stream-XXXXXX)
trap 'rm -f "$temporary"' EXIT

python3 - "$stream_config" "$temporary" "$route_anchor" "$route" "$upstream_anchor" "$upstream" <<'PY'
import pathlib
import sys

source, target, route_anchor, route, upstream_anchor, upstream = sys.argv[1:]
content = pathlib.Path(source).read_text()
assert content.count(route_anchor) == 1
assert content.count(upstream_anchor) == 1
content = content.replace(route_anchor, route_anchor + "\n" + route)
content = content.replace(upstream_anchor, upstream + upstream_anchor)
pathlib.Path(target).write_text(content)
PY

install -m 644 "$temporary" "$stream_config"
if ! nginx -t || ! systemctl reload nginx; then
  cp -p "$backup" "$stream_config"
  nginx -t
  systemctl reload nginx
  exit 1
fi

echo 'AxiomRuntime SNI route enabled.'
