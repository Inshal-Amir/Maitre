#!/usr/bin/env bash
# Create/promote the first administrator explicitly (never via signup). Password is prompted, not logged.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ -n "${1:-}" ] || die "usage: bootstrap-admin.sh admin@${COMPANY_DOMAIN}"
docker exec -it maitre-platform-api-1 python -m app.cli bootstrap-admin --email "$1"
