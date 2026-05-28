// Privilege separation for anonymous capsule workers.
//
// The Node permission sandbox + JS network shim raise the bar, but an anonymous
// worker still runs under the SAME OS uid as the control plane. That's the
// biggest hole: a native-addon escape lands with the host process's identity. To
// close it we drop each anonymous-unclaimed worker to a dedicated UNPRIVILEGED
// uid/gid via child_process fork's `uid`/`gid` options.
//
// This only does anything when the host runs as root (the production container
// runs as a non-root user that CANNOT setuid to another user, so the drop is a
// no-op there — see resolveSandboxUser's root gate). On non-root hosts (dev,
// CI, the hardened container) we degrade gracefully to the prior same-uid
// behaviour rather than crash, mirroring the "Node < 22 → permission disabled"
// fallback. Authenticated/claimed deploys keep the current behaviour regardless.

import { execFileSync } from "node:child_process"

export interface SandboxUser {
  uid: number
  gid: number
  // How the user was resolved — surfaced in the startup log so an operator can
  // tell whether the drop is keyed on an explicit id or the named account.
  source: "env" | "name"
}

// Default unprivileged account a root host drops anonymous workers to. Created
// by the operator (`useradd --system --no-create-home pond-sandbox`); resolved
// at boot via getpwnam(3) through `id`.
export const DEFAULT_SANDBOX_USER = "pond-sandbox"

// Look up a uid + primary gid for a system user name without pulling in a native
// addon: shell out to `id`. Returns null if the user doesn't exist or `id`
// isn't available (e.g. non-POSIX). Best-effort by design.
function lookupUserByName(name: string): { uid: number; gid: number } | null {
  try {
    const uid = Number(execFileSync("id", ["-u", name], { encoding: "utf-8" }).trim())
    const gid = Number(execFileSync("id", ["-g", name], { encoding: "utf-8" }).trim())
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null
    return { uid, gid }
  } catch {
    return null
  }
}

// Resolve a group NAME to a gid. `id -g <name>` treats its argument as a user,
// not a group, so it can't be used here — use getent's group database (the gid
// is the 3rd colon-field). Returns null off-Linux or when the group is unknown,
// so the caller falls back to the user's primary gid.
function lookupGroupByName(name: string): number | null {
  try {
    const line = execFileSync("getent", ["group", name], { encoding: "utf-8" }).trim()
    const gid = Number(line.split(":")[2])
    return Number.isInteger(gid) ? gid : null
  } catch {
    return null
  }
}

function parseId(raw: string | undefined, lookup: (name: string) => number | null): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    return Number.isInteger(n) ? n : null
  }
  return lookup(trimmed)
}

export interface ResolveSandboxUserOpts {
  // POND_SANDBOX_UID — numeric uid or a user name. When set it takes precedence
  // over the named-user fallback.
  uidEnv?: string
  // POND_SANDBOX_GID — numeric gid or a group name. Optional; defaults to the
  // resolved user's primary gid when uidEnv is a name, else to uid.
  gidEnv?: string
  // Named account used when uidEnv is unset (default DEFAULT_SANDBOX_USER).
  userName?: string
  // Effective uid of the current process. Injected for testability; defaults to
  // process.getuid?.(). When not 0 (not root) the drop is impossible — return
  // null so the caller falls back to same-uid.
  effectiveUid?: number | null
}

// Resolve the unprivileged uid/gid anonymous workers should drop to, or null if
// privilege separation isn't possible/configured. null cases (all graceful):
//   - host is not root (can't setuid),
//   - platform has no getuid (Windows),
//   - the configured/named sandbox user can't be resolved.
export function resolveSandboxUser(opts: ResolveSandboxUserOpts = {}): SandboxUser | null {
  const euid = opts.effectiveUid !== undefined ? opts.effectiveUid : (process.getuid?.() ?? null)
  // Only root can change a child's uid/gid. A non-root host (dev, CI, the
  // hardened container) silently keeps current behaviour.
  if (euid !== 0) return null

  const userName = opts.userName ?? DEFAULT_SANDBOX_USER

  // 1) Explicit POND_SANDBOX_UID (numeric or name) wins.
  if (opts.uidEnv && opts.uidEnv.trim()) {
    const uid = parseId(opts.uidEnv, (name) => {
      const u = lookupUserByName(name)
      return u ? u.uid : null
    })
    if (uid === null || uid === 0) return null // refuse to "drop" to root
    let gid = parseId(opts.gidEnv, lookupGroupByName)
    if (gid === null) {
      // No explicit gid: if uidEnv was a name use its primary gid, else mirror uid.
      const byName = /^\d+$/.test(opts.uidEnv.trim()) ? null : lookupUserByName(opts.uidEnv.trim())
      gid = byName ? byName.gid : uid
    }
    return { uid, gid, source: "env" }
  }

  // 2) Fall back to the named system account (default pond-sandbox).
  const resolved = lookupUserByName(userName)
  if (!resolved || resolved.uid === 0) return null
  let gid = parseId(opts.gidEnv, lookupGroupByName)
  if (gid === null) gid = resolved.gid
  return { uid: resolved.uid, gid, source: "name" }
}
