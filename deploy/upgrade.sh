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

# Bail before touching anything if the tunnel config is missing — the compose
# stack will start with cloudflared in a crash loop and pond.run goes 502.
# `cloudflared/config.yml` and `cloudflared/credentials.json` are gitignored
# (they contain secrets) and have to be present locally. See deploy/README.md.
MISSING=()
for f in deploy/cloudflared/config.yml deploy/cloudflared/credentials.json deploy/.env; do
  [[ -f "$f" ]] || MISSING+=("$f")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "missing required local file(s):" >&2
  for f in "${MISSING[@]}"; do echo "  - $f" >&2; done
  echo "" >&2
  echo "These are gitignored secrets. Restore them before upgrading. See" >&2
  echo "deploy/README.md → 'Tunnel config recovery' for how to recreate them." >&2
  exit 1
fi

HAS_GIT=0
if git rev-parse --git-dir >/dev/null 2>&1; then HAS_GIT=1; fi

if [[ "$SKIP_PULL" -eq 0 ]]; then
  if [[ "$HAS_GIT" -eq 0 ]]; then
    echo "no .git directory here — skipping git pull (sync source out-of-band, e.g. rsync, before rerunning)." >&2
    echo "if you want this checkout to be git-tracked, run \`git init && git remote add origin <url> && git fetch && git reset --hard origin/main\`." >&2
  else
    echo "→ git fetch origin"
    git fetch --quiet origin
    echo "→ git pull --ff-only origin main"
    git pull --ff-only origin main
  fi
fi

if [[ "$HAS_GIT" -eq 1 ]]; then
  CURRENT_COMMIT="$(git rev-parse --short HEAD)"
  echo "→ at commit: $CURRENT_COMMIT"
else
  CURRENT_COMMIT="(no-git)"
  echo "→ no .git — rebuilding from current source on disk"
fi

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
