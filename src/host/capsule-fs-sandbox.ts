// Per-capsule OS filesystem isolation via bubblewrap (bwrap).
//
// This is the structural fix for the residual gap documented in
// deploy/HARDENING.md §6: every capsule and the control plane share one uid in
// one container, so the Node `--permission` model is the ONLY thing keeping one
// tenant's files away from another's. `--permission` is a JS-layer boundary —
// if a native-load surface is ever missed (see installSandboxHardening) or the
// permission model is unavailable (Node < 22), a capsule's libc `open()` can
// read control.db, sibling deploys, and the host token. That is exactly how the
// network side works: the JS network shim is a speed bump and nftables is the
// real boundary. This module is the filesystem analogue of nftables.
//
// bwrap builds a fresh mount namespace from an ALLOWLIST: it binds only the
// paths a capsule worker legitimately needs —
//   - the capsule's own deploy dir            (read-write)
//   - the pond runtime source + node_modules  (read-only)
//   - the node binary + system libraries       (read-only)
// — and nothing else. control.db, sibling deploy dirs, and the host-token file
// are simply NOT in the namespace, so they are physically unreachable regardless
// of any JS-layer escape. The `--permission` flags are kept inside the sandbox
// as defense-in-depth.
//
// Linux-only: bwrap needs Linux mount/user namespaces. On any other platform the
// caller must NOT enable this mode (the host startup gate refuses to boot in
// bwrap mode off-Linux rather than running unconfined — never fail open).

import { spawnSync } from "node:child_process"

export type CapsuleFsIsolationMode = "off" | "bwrap"

export interface CapsuleFsConfinement {
  // Absolute, symlink-resolved paths. They must be real paths because bwrap
  // binds the literal path and the worker's `--permission` flags reference the
  // same real paths.
  nodeBin: string
  nodeExecArgv: string[]
  workerPath: string
  deployDir: string
  pondSrcDir: string
  pondNodeModulesDir: string
}

// Read-only system paths bound in so the node binary can dynamically link and
// resolve DNS/TLS. `--ro-bind-try` ignores any that don't exist on a given
// distro, so this list is a superset that degrades gracefully. None of these
// contain tenant data, so exposing them read-only is within the threat model
// (the boundary we care about is tenant-to-tenant and capsule-to-control-plane).
export const SYSTEM_RO_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc/alternatives",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/resolv.conf",
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/passwd",
  "/etc/group",
]

export function resolveFsIsolationMode(value: string | undefined | null): CapsuleFsIsolationMode {
  return (value ?? "").toLowerCase().trim() === "bwrap" ? "bwrap" : "off"
}

// True only on Linux with a working `bwrap` on PATH. spawnSync is cheap and runs
// once at host startup (the gate), not per-deploy.
export function bwrapAvailable(): boolean {
  if (process.platform !== "linux") return false
  try {
    const r = spawnSync("bwrap", ["--version"], { stdio: "ignore", timeout: 5000 })
    return r.status === 0
  } catch {
    return false
  }
}

// Build the bwrap argv that confines a capsule worker. The result is a full
// argv whose argv[0] is "bwrap"; spawn it with stdio that includes an "ipc"
// channel so the control plane keeps its boot/message protocol with the worker.
//
// Pure (no fs / no spawn) so it is fully unit-testable on any platform.
export function buildBwrapArgv(c: CapsuleFsConfinement): string[] {
  const argv: string[] = [
    "bwrap",
    // Kill the sandbox if the control plane dies, so a crashed host never leaks
    // orphaned capsule processes.
    "--die-with-parent",
    // Detach the controlling terminal — blocks TIOCSTI keystroke injection back
    // into the parent's tty.
    "--new-session",
    // Own pid/ipc/uts namespaces: the capsule can't see or signal host or
    // sibling processes, or share SysV IPC. We deliberately do NOT unshare the
    // network namespace (the control plane reaches the worker over loopback and
    // egress is governed by nftables/cgroup) nor the cgroup namespace (the nft
    // egress firewall matches on cgroup membership).
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    // Fresh /proc, minimal /dev, private /tmp — no host /tmp leakage between
    // tenants.
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ]
  for (const p of SYSTEM_RO_PATHS) argv.push("--ro-bind-try", p, p)
  // The node binary itself, in case it lives outside the system dirs above
  // (e.g. an nvm/asdf install under the operator's home).
  argv.push("--ro-bind", c.nodeBin, c.nodeBin)
  // Pond runtime + its dependencies, read-only. workerPath lives under
  // pondSrcDir so it is covered by this bind.
  argv.push("--ro-bind", c.pondSrcDir, c.pondSrcDir)
  argv.push("--ro-bind", c.pondNodeModulesDir, c.pondNodeModulesDir)
  // The capsule's OWN deploy dir, read-write — the only tenant data in the
  // namespace. Its parent (the control plane's data dir, holding control.db,
  // the host token, and every sibling deploy) is never bound, so it does not
  // exist inside the sandbox.
  argv.push("--bind", c.deployDir, c.deployDir)
  argv.push("--chdir", c.deployDir)
  argv.push("--", c.nodeBin, ...c.nodeExecArgv, c.workerPath)
  return argv
}
