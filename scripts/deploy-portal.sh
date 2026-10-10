#!/usr/bin/env bash
set -euo pipefail

for variable in PORTAL_SSH_HOST PORTAL_SSH_USER PORTAL_SSH_PRIVATE_KEY_B64 PORTAL_SSH_KNOWN_HOSTS CI_COMMIT_SHA CI_JOB_ID; do
  if [[ -z "${!variable:-}" ]]; then
    echo "$variable is required" >&2
    exit 1
  fi
done

if [[ ! -f web/dist/portal/index.html ]]; then
  echo "Portal build artifact is missing" >&2
  exit 1
fi

deploy_root="${PORTAL_DEPLOY_ROOT:-/srv/axiomruntime-portal}"
health_url="${PORTAL_HEALTH_URL:-https://axiom.offerpilot.life/}"
release="${CI_COMMIT_SHA}-${CI_JOB_ID}"
if [[ ! "$deploy_root" =~ ^/[A-Za-z0-9/_-]+$ || "$deploy_root" == "/" || ! "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]]; then
  echo "Invalid deployment path or commit SHA" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
chmod 700 "$work_dir"
if ! printf '%s' "$PORTAL_SSH_PRIVATE_KEY_B64" | base64 --decode > "$work_dir/key"; then
  echo "Invalid PORTAL_SSH_PRIVATE_KEY_B64" >&2
  exit 1
fi
printf '%s\n' "$PORTAL_SSH_KNOWN_HOSTS" > "$work_dir/known_hosts"
chmod 600 "$work_dir/key" "$work_dir/known_hosts"
ssh_options=(-i "$work_dir/key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work_dir/known_hosts")
remote="${PORTAL_SSH_USER}@${PORTAL_SSH_HOST}"

ssh "${ssh_options[@]}" "$remote" bash -s -- "$deploy_root" "$release" <<'REMOTE'
set -euo pipefail
root="$1"
release="$2"
mkdir "$root/releases/$release"
REMOTE
rsync -az --delete -e "ssh -i $work_dir/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$work_dir/known_hosts" web/dist/portal/ "$remote:$deploy_root/releases/$release/"

previous="$(ssh "${ssh_options[@]}" "$remote" bash -s -- "$deploy_root" <<'REMOTE'
set -euo pipefail
root="$1"
if [[ -L "$root/current" ]]; then readlink "$root/current"; fi
REMOTE
)"

ssh "${ssh_options[@]}" "$remote" bash -s -- "$deploy_root" "$release" <<'REMOTE'
set -euo pipefail
root="$1"
release="$2"
ln -sfn "releases/$release" "$root/.current-next"
mv -Tf "$root/.current-next" "$root/current"
REMOTE

if ! curl --fail --silent --show-error --location --max-time 20 --output "$work_dir/live-index.html" "$health_url" || ! cmp --silent web/dist/portal/index.html "$work_dir/live-index.html"; then
  echo "Portal health check failed; restoring previous release" >&2
  if [[ -n "$previous" ]]; then
    ssh "${ssh_options[@]}" "$remote" bash -s -- "$deploy_root" "$previous" <<'REMOTE'
set -euo pipefail
root="$1"
previous="$2"
ln -sfn "$previous" "$root/.current-rollback"
mv -Tf "$root/.current-rollback" "$root/current"
REMOTE
  else
    ssh "${ssh_options[@]}" "$remote" bash -s -- "$deploy_root" <<'REMOTE'
set -euo pipefail
root="$1"
if [[ -L "$root/current" ]]; then unlink "$root/current"; fi
REMOTE
  fi
  exit 1
fi

echo "Portal release $release is live at $health_url"
