#!/bin/sh
# Volume mounts (Railway Volumes, compose named volumes) land root-owned, which
# the unprivileged `node` user can't write. When started as root, fix ownership
# of the data dir, then drop to `node` so the control plane + capsules run
# unprivileged. When already non-root (no mounted volume to fix), just exec.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data 2>/dev/null || true
  exec gosu node "$@"
fi
exec "$@"
