// Symlink-safe filesystem primitives for host-side access to capsule deploy
// dirs. Capsules have read/write access to their own deploy dir (Node
// --permission grants --allow-fs-write=<deployDir> and bwrap mounts it rw), so
// the host must treat that directory as attacker-controlled: a capsule-planted
// symlink must never make the host follow it to host-token, a sibling deploy's
// .env.pond.server, or src/host/deploy-worker.js (the file-write→RCE chain).
//
// Rules:
//  - Reads resolve the full path with realpath() and require the result to
//    stay inside the root's realpath. A symlink escaping the deploy dir (to
//    host data or a sibling) is rejected; a symlink pointing at tenant data
//    inside the dir is allowed (it is the tenant's own content).
//  - Writes go through a temp file + rename: rename(2) replaces a symlink at
//    the destination instead of following it, and the temp file lives in the
//    *resolved* parent directory, so a parent directory swapped for a symlink
//    after our check cannot redirect the write either.
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"

function isInside(rootReal: string, targetReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep)
}

// Realpath of `abs` when it (and every ancestor below `root`) resolves inside
// `root`'s realpath — otherwise null. The root itself is the trust boundary:
// the host created it, so symlinks at or above it are out of scope.
export function containedRealPath(root: string, abs: string): string | null {
  if (abs === root) {
    try {
      return fs.realpathSync(root)
    } catch {
      return null
    }
  }
  let rootReal: string
  let real: string
  try {
    rootReal = fs.realpathSync(root)
    real = fs.realpathSync(abs)
  } catch {
    // Nonexistent path (or a broken symlink) — nothing to read, nothing to
    // follow.
    return null
  }
  return isInside(rootReal, real) ? real : null
}

// Read a file that must resolve inside `root`. Returns null when the file is
// missing, unreadable, or escapes the root via a symlink.
export function safeReadFile(root: string, abs: string): Buffer | null {
  const real = containedRealPath(root, abs)
  if (!real) return null
  try {
    return fs.readFileSync(real)
  } catch {
    return null
  }
}

// Write `data` to `abs`, where `abs` must be lexically inside `root`. The file
// is written to a temp name in the resolved parent directory and renamed into
// place, so a pre-existing symlink at the destination is replaced (never
// followed) and a parent directory swapped for an escaping symlink between our
// check and the write cannot redirect the rename (the rename targets the
// verified parent). Throws on failure.
export function safeWriteFile(root: string, abs: string, data: string | Buffer, opts: { mode?: number } = {}): void {
  const dir = path.dirname(abs)
  fs.mkdirSync(dir, { recursive: true })
  const dirReal = containedRealPath(root, dir)
  if (!dirReal) {
    throw new Error("refusing to write through a symlink escaping the deploy dir")
  }
  const tmp = path.join(dirReal, `.pond-tmp-${randomBytes(8).toString("hex")}`)
  fs.writeFileSync(tmp, data, { mode: opts.mode })
  try {
    fs.renameSync(tmp, path.join(dirReal, path.basename(abs)))
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // best effort
    }
    throw err
  }
}
