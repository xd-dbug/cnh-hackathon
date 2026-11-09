#!/usr/bin/env bash
# Creates or updates the "Clash Resolver: Site Health" dashboard in Dash0. Safe to re-run:
# PUT by a fixed id updates the same dashboard instead of making a copy.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

env_dir="${CNH_ENV_DIR:-/home/xd/hackathon-env}"
if [[ -z "${DASH0_ENDPOINT:-}" || -z "${DASH0_AUTH_TOKEN:-}" ]]; then
  set -a; source "$env_dir/dash0.env"; set +a
fi

# The API lives next to the ingress endpoint: ingress.<region>.aws.dash0.com → api.<region>.aws.dash0.com
host="${DASH0_ENDPOINT#*://}"; host="${host%%:*}"
api="${DASH0_API_URL:-https://${host/ingress./api.}}"
id=clash-resolver-site-health

status=$(node site-health.mjs | curl -sS -o /dev/null -w '%{http_code}' -X PUT \
  -H "Authorization: Bearer $DASH0_AUTH_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @- "$api/api/dashboards/$id?dataset=default")
if [[ "$status" != 2* ]]; then
  echo "Dash0 returned HTTP $status for dashboard $id" >&2
  exit 1
fi
echo "Dashboard $id applied ($api). In Dash0: Dashboards → Clash Resolver: Site Health"
