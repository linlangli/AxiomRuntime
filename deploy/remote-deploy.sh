#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: remote-deploy.sh <deploy-dir> <image> <registry> <docker-config-dir>" >&2
  exit 2
fi

deploy_dir=$1
image=$2
registry=$3
docker_config=$4
candidate_compose="$deploy_dir/docker-compose.prod.yml.next"
active_compose="$deploy_dir/docker-compose.prod.yml"
deploy_env="$deploy_dir/.deploy.env"
previous_env="$deploy_dir/.deploy.env.previous"

if [[ ! "$docker_config" =~ ^"$deploy_dir"/\.docker-auth-[0-9]+$ ]]; then
  echo "Unsafe Docker config directory: $docker_config" >&2
  exit 1
fi
export DOCKER_CONFIG="$docker_config"

cleanup_registry_auth() {
  docker logout "$registry" >/dev/null 2>&1 || true
  rm -rf -- "$docker_config"
}
trap cleanup_registry_auth EXIT

cd "$deploy_dir"

if [[ ! -s "$candidate_compose" ]]; then
  echo "Candidate Compose file is missing: $candidate_compose" >&2
  exit 1
fi
if [[ ! -s "$deploy_dir/config/providers.json" ]]; then
  echo "Provider configuration is missing: $deploy_dir/config/providers.json" >&2
  exit 1
fi
if [[ ! -s "$deploy_dir/secrets/server-token" ]]; then
  echo "Runtime token is missing: $deploy_dir/secrets/server-token" >&2
  exit 1
fi

mkdir -p "$deploy_dir/workspaces"
docker network inspect ai-runtime >/dev/null 2>&1 || docker network create ai-runtime >/dev/null

if [[ -f "$deploy_env" ]]; then
  cp "$deploy_env" "$previous_env"
else
  rm -f "$previous_env"
fi

umask 077
printf 'AI_GATEWAY_IMAGE=%s\n' "$image" > "$deploy_env.next"
mv "$deploy_env.next" "$deploy_env"

env_args=()
if [[ -f "$deploy_dir/.env" ]]; then
  env_args+=(--env-file "$deploy_dir/.env")
fi
env_args+=(--env-file "$deploy_env")
candidate=(docker compose "${env_args[@]}" -f "$candidate_compose")

rollback() {
  echo "Deployment failed; restoring the previous AxiomRuntime release." >&2
  if [[ -f "$previous_env" && -f "$active_compose" ]]; then
    mv "$previous_env" "$deploy_env"
    previous=(docker compose "${env_args[@]}" -f "$active_compose")
    "${previous[@]}" up -d --remove-orphans
  else
    rm -f "$deploy_env"
  fi
}

wait_for_runtime() {
  local container_id status
  for _ in {1..60}; do
    container_id=$("${candidate[@]}" ps -q runtime)
    if [[ -n "$container_id" ]]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
      if [[ "$status" == "healthy" ]]; then
        return 0
      fi
      if [[ "$status" == "unhealthy" || "$status" == "exited" || "$status" == "dead" ]]; then
        return 1
      fi
    fi
    sleep 2
  done
  return 1
}

deploy_candidate() {
  "${candidate[@]}" config --quiet
  "${candidate[@]}" pull
  docker run --rm --entrypoint /usr/bin/test \
    -v "$deploy_dir/config:/var/lib/ai-gateway" \
    "$image" -r /var/lib/ai-gateway/providers.json
  "${candidate[@]}" up -d --remove-orphans
  wait_for_runtime

  if "${candidate[@]}" config --services | grep -qx telegram; then
    local telegram_id
    telegram_id=$("${candidate[@]}" ps -q telegram)
    [[ -n "$telegram_id" ]]
    [[ $(docker inspect --format '{{.State.Status}}' "$telegram_id") == "running" ]]
  fi
}

if ! deploy_candidate; then
  rollback
  exit 1
fi

mv "$candidate_compose" "$active_compose"
rm -f "$previous_env"
echo "Deployed $image"
