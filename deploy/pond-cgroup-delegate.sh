#!/bin/bash
# Re-applies cgroup v2 delegation of pond.slice to uid 1000 (the container's
# `node` user) so the pond control plane can place its manager + per-capsule
# workers under POND_CAPSULE_CGROUP_ROOT=/sys/fs/cgroup/pond.slice.
#
# Why this exists: with Docker's systemd cgroup driver, the compose service uses
# `cgroup: host` + `cgroup_parent: pond.slice`, so Docker creates pond.slice when
# the container starts. cgroup v2 only lets an unprivileged process move pids
# between cgroups it owns within a delegated subtree — so pond.slice (the common
# ancestor of the container scope, the manager cgroup, and every capsule cgroup)
# must be owned by uid 1000 with cpu/memory/pids in its subtree_control. Docker
# does not delegate it, so we do, on every boot (and rejoin pond-host if it
# started before delegation was in place). Install via pond-cgroup-delegate.service.
set -u
SL=/sys/fs/cgroup/pond.slice
for i in $(seq 1 30); do [ -d "$SL" ] && break; sleep 1; done
[ -d "$SL" ] || { echo "pond.slice absent; nothing to do"; exit 0; }
echo "+cpu +memory +pids" > "$SL/cgroup.subtree_control" 2>/dev/null || \
  for c in cpu memory pids; do echo "+$c" > "$SL/cgroup.subtree_control" 2>/dev/null || true; done
chown 1000 "$SL" "$SL/cgroup.procs" "$SL/cgroup.subtree_control" 2>/dev/null || true
if [ ! -d "$SL/manager" ]; then
  echo "manager cgroup missing — restarting pond-host so it rejoins"
  docker restart deploy-pond-host-1 >/dev/null 2>&1 || true
fi
echo "delegation applied: owner=$(stat -c %u "$SL") controllers=$(cat "$SL/cgroup.subtree_control")"
