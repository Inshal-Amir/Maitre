# Shared helpers for server scripts (run inside WSL on the GPU PC).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SECRETS="$REPO/.server-secrets"
COMPOSE_DIR="$REPO/maitre/infra/server"
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { say "ERROR: $*"; exit 1; }
[ -f "$SECRETS/server.env" ] || die "missing $SECRETS/server.env (copy maitre/infra/server/server.env.example and fill it in)"
set -a; . "$SECRETS/server.env"; set +a
export MAITRE_HOST_UID="${MAITRE_HOST_UID:-$(id -u)}" MAITRE_HOST_GID="${MAITRE_HOST_GID:-$(id -g)}"
export MAITRE_REPO_DIR="$REPO"
# Empty placeholder so compose can parse; owned by the host user (the deployer runs as root) so it can be edited.
[ -e "$SECRETS/cloudflared_token_menthiq" ] || { install -m 600 -o "$MAITRE_HOST_UID" -g "$MAITRE_HOST_GID" /dev/null "$SECRETS/cloudflared_token_menthiq" 2>/dev/null || true; }
export COMPANY_DOMAIN="${COMPANY_DOMAIN:-menthiq.com}"
export CONSOLE_HOST="${CONSOLE_HOST:-maitre.$COMPANY_DOMAIN}" API_HOST="${API_HOST:-api.$COMPANY_DOMAIN}"
MAITRE_ENGINE="${MAITRE_ENGINE:-llamacpp}"
case "$MAITRE_ENGINE" in llamacpp|vllm) ;; *) die "MAITRE_ENGINE must be llamacpp or vllm (got: $MAITRE_ENGINE)" ;; esac
MODEL_PATH="$MAITRE_MODEL_DIR/$MAITRE_MODEL_SUBDIR${MAITRE_MODEL_FILE:+/$MAITRE_MODEL_FILE}"
dc() { docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/compose.yaml" -f "$COMPOSE_DIR/model.$MAITRE_ENGINE.yaml" \
  --env-file "$SECRETS/server.env" "$@"; }
