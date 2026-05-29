#!/bin/bash
# Keeps pond.slice delegated to uid 1000 across EVERY (re)start of the pond-host
# container, not just at boot. The boot-only oneshot left a gap: a
# `docker compose up -d` that recreates the container resets pond.slice to
# root-ownership, and the running pond falls back to heap-cap-only ("could not
# place deploy … in a cgroup") until the next reboot. This watches Docker for
# start events of the pond-host compose service and re-runs the delegate (which
# also nudges pond to re-probe if it came up before delegation was reapplied).
#
# Install via pond-cgroup-watch.service. See deploy/pond-cgroup-delegate.sh.
set -u

DELEGATE=/usr/local/sbin/pond-cgroup-delegate.sh

# Catch a container that is already running when this service (re)starts (e.g.
# the watcher was restarted but the container wasn't).
"$DELEGATE" || true

# Re-apply on every future start of the pond-host compose service. Filtering on
# the compose labels (not the container name/id) matches across recreates: the
# name/id change, the labels don't. This blocks and streams forever; systemd
# Restart=always brings it back if the Docker daemon bounces.
docker events \
  --filter 'event=start' \
  --filter 'label=com.docker.compose.project=deploy' \
  --filter 'label=com.docker.compose.service=pond-host' \
  --format '{{.Time}} {{.Actor.Attributes.name}}' \
| while read -r line; do
    echo "container start: $line — reapplying delegation"
    "$DELEGATE" || true
  done
