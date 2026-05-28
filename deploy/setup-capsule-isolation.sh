#!/usr/bin/env bash
#
# One-time (re-runnable) host setup for per-capsule isolation:
#   1. a delegated cgroup v2 subtree the pond-host process can manage, and
#   2. a default-deny egress firewall for capsule cgroups.
#
# Run as root on the host BEFORE pointing pond-host at the cgroup root:
#
#   sudo POND_CAPSULE_CGROUP_ROOT=/sys/fs/cgroup/pond POND_RUN_USER=pond \
#     deploy/setup-capsule-isolation.sh
#
# Then set POND_CAPSULE_CGROUP_ROOT in the pond-host environment (deploy/.env
# for Docker, or the systemd unit) and restart. The host logs
# "capsule isolation: cgroup v2 enabled" when it takes effect.
#
# Idempotent and safe to re-run. Exits non-zero on a fatal misconfiguration.

set -euo pipefail

CGROUP_ROOT="${POND_CAPSULE_CGROUP_ROOT:-/sys/fs/cgroup/pond}"
RUN_USER="${POND_RUN_USER:-pond}"
CGROUP_MOUNT="/sys/fs/cgroup"
NEED_CONTROLLERS="cpu memory pids"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NFT_RULES="${SCRIPT_DIR}/capsule-egress.nft"

if [[ "${EUID}" -ne 0 ]]; then
  echo "must run as root (cgroup + nftables setup needs privilege)." >&2
  exit 1
fi

# ── cgroup v2 ──────────────────────────────────────────────────────────────
if [[ ! -f "${CGROUP_MOUNT}/cgroup.controllers" ]]; then
  echo "cgroup v2 unified hierarchy not found at ${CGROUP_MOUNT}." >&2
  echo "Boot with systemd.unified_cgroup_hierarchy=1 (most modern distros already do)." >&2
  exit 1
fi

available="$(cat "${CGROUP_MOUNT}/cgroup.controllers")"
for c in ${NEED_CONTROLLERS}; do
  case " ${available} " in
    *" ${c} "*) ;;
    *)
      echo "controller '${c}' is not available at the cgroup root (have: ${available})." >&2
      exit 1
      ;;
  esac
done

# Make sure cpu/memory/pids are delegated from the root down to children.
# Harmless if already enabled; systemd typically has these on.
for c in ${NEED_CONTROLLERS}; do
  echo "+${c}" > "${CGROUP_MOUNT}/cgroup.subtree_control" 2>/dev/null || true
done

# Create the pond parent cgroup and enable controllers for ITS children, so the
# per-capsule cgroups pond-host creates can carry cpu.max/memory.max/pids.max.
mkdir -p "${CGROUP_ROOT}"
for c in ${NEED_CONTROLLERS}; do
  if ! echo "+${c}" > "${CGROUP_ROOT}/cgroup.subtree_control" 2>/dev/null; then
    echo "warning: could not enable '${c}' on ${CGROUP_ROOT}/cgroup.subtree_control" >&2
  fi
done

# Delegate the subtree to the unprivileged run user (cgroup v2 delegation set:
# the directory plus cgroup.procs and cgroup.subtree_control). This lets the
# pond-host process create capsule-<id> cgroups and migrate worker pids into
# them without being root.
if id "${RUN_USER}" >/dev/null 2>&1; then
  chown "${RUN_USER}" \
    "${CGROUP_ROOT}" \
    "${CGROUP_ROOT}/cgroup.procs" \
    "${CGROUP_ROOT}/cgroup.subtree_control" 2>/dev/null || true
  echo "delegated ${CGROUP_ROOT} to user '${RUN_USER}'."
else
  echo "note: user '${RUN_USER}' not found — skipping chown. If pond-host runs as root (e.g. in the container), this is fine." >&2
fi

echo "cgroup root ready: ${CGROUP_ROOT}"
echo "  controllers (subtree_control): $(cat "${CGROUP_ROOT}/cgroup.subtree_control" 2>/dev/null || echo '?')"

# ── egress firewall ────────────────────────────────────────────────────────
if command -v nft >/dev/null 2>&1; then
  if [[ -f "${NFT_RULES}" ]]; then
    nft -f "${NFT_RULES}"
    echo "egress ruleset loaded: $(basename "${NFT_RULES}") (table inet pond)."
    echo "  inspect with: nft list table inet pond"
    echo "  to persist across reboots, include it from /etc/nftables.conf."
  else
    echo "warning: ${NFT_RULES} not found — skipped egress firewall." >&2
  fi
else
  echo "warning: 'nft' not installed — skipped egress firewall. Install nftables to close the DNS/native-addon exfil gap." >&2
fi

echo "done."
