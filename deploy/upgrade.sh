#!/usr/bin/env bash
# Pull the latest main and rebuild the pond-host Docker stack in place.
# Run this on the host that runs pond.run (or your equivalent). Safe to re-run.
#
# Usage:
#   cd /path/to/pond
#   ./deploy/upgrade.sh             # pull + rebuild + restart
#   ./deploy/upgrade.sh --skip-pull # rebuild without git pull (use after a manual checkout)
#
# Exits non-zero on any failure.

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_PULL=0
for arg in "$@"; do
  case "$arg" in
    --skip-pull) SKIP_PULL=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f deploy/docker-compose.yml ]]; then
  echo "deploy/docker-compose.yml not found — run from the pond repo root." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not on PATH." >&2
  exit 1
fi

if [[ "$SKIP_PULL" -eq 0 ]]; then
  echo "→ git fetch origin"
  git fetch --quiet origin
  echo "→ git pull --ff-only origin main"
  git pull --ff-only origin main
fi

CURRENT_COMMIT="$(git rev-parse --short HEAD)"
echo "→ at commit: $CURRENT_COMMIT"

echo "→ docker compose -f deploy/docker-compose.yml build pond-host"
docker compose -f deploy/docker-compose.yml build pond-host

echo "→ docker compose -f deploy/docker-compose.yml up -d"
docker compose -f deploy/docker-compose.yml up -d

echo "→ docker compose ps"
docker compose -f deploy/docker-compose.yml ps

echo "→ recent pond-host logs"
docker compose -f deploy/docker-compose.yml logs --tail=20 pond-host || true

echo ""
echo "✓ upgraded to $CURRENT_COMMIT"
