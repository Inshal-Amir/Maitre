#!/usr/bin/env bash
# One-time move of a running server from the product's old name (zehnora) to Maitre, keeping all data:
#   1. stops the old containers (zehnora-*), 2. copies the database volume zehnora_pgdata -> maitre_pgdata,
#   3. renames the variables in .server-secrets/*.env (a .pre-rename backup of each changed file is kept),
#   4. renames the model folder when its path contains the old name, 5. renames the databases, roles and the model
#   alias (rename-db.sql), 6. starts everything with start.sh --with-tunnel, setup-platform.sh and the auto-deploy.
# Safe to run again. The old volume stays as a backup; remove it later with: docker volume rm zehnora_pgdata
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SECRETS="$REPO/.server-secrets"
OLD=zehnora
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { say "ERROR: $*"; exit 1; }
docker info >/dev/null 2>&1 || die "Docker is not running"
[ -f "$SECRETS/server.env" ] || die "missing $SECRETS/server.env"

old_containers="$(docker ps -aq --filter "label=com.docker.compose.project=$OLD")"
if [ -n "$old_containers" ]; then
  say "stopping the old containers"
  docker stop zehnora-deployer-1 >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker stop $old_containers >/dev/null && docker rm $old_containers >/dev/null
fi

if docker volume inspect "${OLD}_pgdata" >/dev/null 2>&1 && ! docker volume inspect maitre_pgdata >/dev/null 2>&1; then
  say "copying the database volume ${OLD}_pgdata -> maitre_pgdata"
  docker volume create maitre_pgdata >/dev/null
  docker run --rm -v "${OLD}_pgdata:/from:ro" -v maitre_pgdata:/to postgres:17.6 sh -c 'cp -a /from/. /to/'
fi

for f in "$SECRETS"/*.env; do
  grep -qi "$OLD" "$f" || continue
  [ -e "$f.pre-rename" ] || install -m 600 "$f" "$f.pre-rename"
  sed -i -e 's/ZEHNORA_/MAITRE_/g' -e 's/zehnora_platform/maitre_platform/g' -e 's/zehnora_litellm/maitre_litellm/g' \
    -e 's/zehnora-coder/maitre-coder/g' -e 's/zehnora/maitre/g' -e 's/Zehnora/Maitre/g' "$f"
  say "renamed the variables in $(basename "$f") (backup: $(basename "$f").pre-rename)"
done

model_dir="$(sed -n 's/^MAITRE_MODEL_DIR=//p' "$SECRETS/server.env" | tr -d '"' | head -1)"
old_model_dir="$(printf '%s' "$model_dir" | sed 's/maitre/zehnora/g')"
if [ -n "$model_dir" ] && [ "$model_dir" != "$old_model_dir" ] && [ -d "$old_model_dir" ] && [ ! -e "$model_dir" ]; then
  say "renaming the model folder $old_model_dir -> $model_dir"
  mv "$old_model_dir" "$model_dir"
fi

if [ ! -f "$REPO/maitre/portal/dist/index.html" ]; then
  if [ -f "$REPO/$OLD/portal/dist/index.html" ]; then
    say "moving the built portal to maitre/portal/dist"; mkdir -p "$REPO/maitre/portal" && mv "$REPO/$OLD/portal/dist" "$REPO/maitre/portal/dist"
  else
    say "building the portal"; "$HERE/build-portal.sh"
  fi
fi

. "$HERE/common.sh"
say "renaming the databases, roles and model alias"
dc up -d postgres >/dev/null
i=0; until [ "$(docker inspect -f '{{.State.Health.Status}}' maitre-postgres-1 2>/dev/null)" = healthy ]; do
  i=$((i+1)); [ $i -ge 60 ] && die "postgres not healthy (docker logs maitre-postgres-1)"; sleep 3; done
docker exec -i maitre-postgres-1 psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <"$HERE/rename-db.sql" >/dev/null

"$HERE/start.sh" --with-tunnel
"$HERE/setup-platform.sh"
"$HERE/enable-autodeploy.sh"
"$HERE/health.sh"
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep "^$OLD/" | xargs -r docker image rm >/dev/null 2>&1 || true
docker network ls --format '{{.Name}}' | grep "^${OLD}_" | xargs -r docker network rm >/dev/null 2>&1 || true
say "done: Maitre runs under its new names. Old database volume kept as a backup (docker volume rm ${OLD}_pgdata when you are sure)."
