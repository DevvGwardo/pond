// Unit tests for the symlink-safe fs primitives the host uses on tenant-
// writable deploy dirs. A capsule can plant symlinks in its own directory; the
// host must never follow one out of the deploy dir (host-token, sibling env
// files, deploy-worker.js).

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containedRealPath, safeReadFile, safeWriteFile } from "../src/host/fs-safe.js"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pond-fs-safe-"))
  writeFileSync(join(root, "plain.txt"), "hello")
  writeFileSync(join(root, "secret.txt"), "host-secret")
  writeFileSync(join(root, "sibling.txt"), "sibling-data")
  return root
}

test("containedRealPath accepts paths inside the root", () => {
  const root = fixture()
  try {
    // Returns the realpath (macOS /var → /private/var), which must stay
    // inside the root's realpath.
    assert.equal(containedRealPath(root, join(root, "plain.txt")), realpathSync(join(root, "plain.txt")))
    assert.equal(containedRealPath(root, root), realpathSync(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("containedRealPath rejects a symlink escaping the root", () => {
  const root = fixture()
  const outside = mkdtempSync(join(tmpdir(), "pond-fs-safe-outside-"))
  try {
    writeFileSync(join(outside, "victim.txt"), "outside-data")
    symlinkSync(join(outside, "victim.txt"), join(root, "escape.txt"))
    symlinkSync("/etc", join(root, "escape-dir"))
    // Symlinks to the OUTSIDE are rejected even though the path lexically
    // lives inside the root.
    assert.equal(containedRealPath(root, join(root, "escape.txt")), null)
    assert.equal(containedRealPath(root, join(root, "escape-dir", "passwd")), null)
    // Symlinks pointing at sibling data INSIDE the root resolve fine.
    symlinkSync(join(root, "sibling.txt"), join(root, "alias.txt"))
    assert.ok(containedRealPath(root, join(root, "alias.txt")) !== null)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test("safeReadFile refuses a symlink that escapes the root", () => {
  const root = fixture()
  try {
    symlinkSync(join(root, "secret.txt"), join(root, "leak.txt"))
    // The target is inside the root — allowed (it is tenant data).
    assert.equal(safeReadFile(root, join(root, "leak.txt"))?.toString(), "host-secret")
    // Now point the symlink OUTSIDE the root: must be refused.
    symlinkSync("/etc/hosts", join(root, "outside-leak.txt"))
    assert.equal(safeReadFile(root, join(root, "outside-leak.txt")), null)
    // Missing files return null, not throw.
    assert.equal(safeReadFile(root, join(root, "nope.txt")), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("safeWriteFile replaces a symlink at the destination instead of following it", () => {
  const root = fixture()
  try {
    const target = join(root, "secret.txt")
    symlinkSync(target, join(root, "deploy.json"))
    safeWriteFile(root, join(root, "deploy.json"), "new-content")
    // The symlink must have been replaced, not followed: secret.txt is
    // untouched and deploy.json is now a regular file with the new content.
    assert.equal(readFileSync(target, "utf8"), "host-secret")
    assert.equal(readFileSync(join(root, "deploy.json"), "utf8"), "new-content")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("safeWriteFile refuses to write through a parent symlink that escapes the root", () => {
  const root = fixture()
  try {
    const outside = mkdtempSync(join(tmpdir(), "pond-fs-safe-outside-"))
    symlinkSync(outside, join(root, "evil-dir"))
    assert.throws(() => safeWriteFile(root, join(root, "evil-dir", "file.txt"), "x"), /symlink/)
    // Nothing was written outside.
    assert.equal(existsSync(join(outside, "file.txt")), false)
    rmSync(outside, { recursive: true, force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("safeWriteFile creates intermediate directories", () => {
  const root = fixture()
  try {
    safeWriteFile(root, join(root, "a", "b", "c.txt"), "deep")
    assert.equal(readFileSync(join(root, "a", "b", "c.txt"), "utf8"), "deep")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
