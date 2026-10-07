#!/usr/bin/env bash
# Start the server profile in dependency order and wait for readiness.
#   start.sh                 local-only (nginx on 127.0.0.1:8080)
#   start.sh --with-tunnel   also start the Cloudflare Tunnel connector (after local tests pass)
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ -e "$MODEL_PATH" ] || die "model not downloaded ($MODEL_PATH): run download-model.sh"
GUARD_LOCK="$REPO/.server-state/guard.lock"
# The hardware guard is optional: ZEHNORA_GUARD=on in server.env turns it on (default off while it is being checked).
GUARD="${ZEHNORA_GUARD:-off}"
if [ "$GUARD" = on ] && [ -f "$GUARD_LOCK" ]; then
  case "$(cut -d' ' -f1 "$GUARD_LOCK")" in
    cooldown) die "the hardware guard is cooling the GPU down; it restarts the model by itself ($(cat "$GUARD_LOCK"))" ;;
    *) die "the hardware guard shut the model down: $(cat "$GUARD_LOCK"). Check the PC, then run guard-reset.sh" ;;
  esac
fi
[ -f "$REPO/zehnora/portal/dist/index.html" ] || die "portal not built: cd zehnora/portal && npm ci && npm run build"
docker info >/dev/null 2>&1 || die "Docker is not running (start Docker Desktop with the WSL2 backend)"
say "building images (litellm, platform-api)"; dc build
if [ "$GUARD" = on ]; then
  dc up -d guard >/dev/null && say "hardware guard running (docker logs zehnora-guard-1)"
else
  docker rm -f zehnora-guard-1 >/dev/null 2>&1 && say "hardware guard removed (ZEHNORA_GUARD=off)" || say "hardware guard off (ZEHNORA_GUARD=off)"
fi
say "starting postgres + model ($ZEHNORA_ENGINE; loading can take minutes)"; dc up -d postgres model
wait_healthy() { local s="$1" i=0; until [ "$(docker inspect -f '{{.State.Health.Status}}' "zehnora-$s-1" 2>/dev/null)" = healthy ]; do
  i=$((i+1)); [ $i -ge 180 ] && die "$s not healthy (dc logs $s)"; sleep 5; done; say "$s healthy"; }
wait_healthy postgres
# Create or update the two application roles/databases from the secret files (idempotent; passwords via stdin only).
ensure_databases() {
  { printf '\\set platform_pw %s\n' "'$(cat "$SECRETS/pg_platform_password")'"
    printf '\\set litellm_pw %s\n' "'$(cat "$SECRETS/pg_litellm_password")'"
    for r in platform litellm; do cat <<SQL
SELECT 'CREATE ROLE zehnora_$r LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zehnora_$r')\\gexec
ALTER ROLE zehnora_$r WITH LOGIN PASSWORD :'${r}_pw';
SELECT 'CREATE DATABASE zehnora_$r OWNER zehnora_$r' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'zehnora_$r')\\gexec
REVOKE ALL ON DATABASE zehnora_$r FROM PUBLIC;
SQL
    done; } | docker exec -i zehnora-postgres-1 psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
  say "databases zehnora_platform + zehnora_litellm ready"
}
ensure_databases
wait_healthy model
dc up -d litellm; wait_healthy litellm
dc up -d platform-api; wait_healthy platform-api
dc up -d nginx
if [ "${1:-}" = "--with-tunnel" ]; then
  tok="$SECRETS/cloudflared_token_menthiq"
  # Accept the whole install command pasted from the dashboard: keep only the token.
  if [ -s "$tok" ] && grep -q ' ' "$tok"; then t="$(grep -o 'eyJ[A-Za-z0-9_=-]*' "$tok" | head -1)"; [ -n "$t" ] && printf '%s' "$t" >"$tok"; fi
  [ -s "$tok" ] || die "missing tunnel token: paste it into $tok"
  dc --profile tunnel up -d --remove-orphans cloudflared
  # The token is a mounted secret: a new token does not change the compose config, so restart to load it.
  stamp="$SECRETS/.cloudflared_token.sha"; sum="$(sha256sum "$tok" | cut -d' ' -f1)"
  if [ "$(cat "$stamp" 2>/dev/null)" != "$sum" ]; then docker restart zehnora-cloudflared-1 >/dev/null; printf '%s' "$sum" >"$stamp"; say "tunnel token changed: connector restarted"; fi
  say "tunnel connector started (menthiq.com)"
fi
say "model deployment: $ZEHNORA_MODEL_REPO @ ${ZEHNORA_MODEL_REVISION:0:12} ${ZEHNORA_MODEL_FILE:-} ($ZEHNORA_ENGINE, ctx ${ZEHNORA_MAX_MODEL_LEN:-})"
docker exec zehnora-model-1 nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader || true
say "local check: curl -s -H 'Host: $API_HOST' http://127.0.0.1:8080/v1/models"
