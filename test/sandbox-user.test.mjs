// Unit tests for anonymous-worker privilege-drop resolution.
//
// The actual setuid drop can only be exercised on a root Linux host, so here we
// cover what's platform-independent: the uid/gid resolution logic and — most
// importantly for non-root CI — that it degrades to "no drop" (null) whenever
// the host isn't root or the sandbox user can't be resolved. `effectiveUid` is
// injectable so we can drive the root path without actually being root.

import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveSandboxUser, DEFAULT_SANDBOX_USER } from "../src/host/sandbox-user.js"

test("returns null when the host is not root (no drop possible)", () => {
  // Even with an explicit numeric uid, a non-root host can't setuid a child.
  assert.equal(resolveSandboxUser({ effectiveUid: 1000, uidEnv: "1234", gidEnv: "1234" }), null)
  assert.equal(resolveSandboxUser({ effectiveUid: 1000 }), null)
})

test("returns null when getuid is unavailable (e.g. Windows)", () => {
  assert.equal(resolveSandboxUser({ effectiveUid: null }), null)
})

test("root + explicit numeric uid/gid resolves to that pair", () => {
  const u = resolveSandboxUser({ effectiveUid: 0, uidEnv: "1234", gidEnv: "5678" })
  assert.deepEqual(u, { uid: 1234, gid: 5678, source: "env" })
})

test("root + numeric uid without gid mirrors uid as gid", () => {
  const u = resolveSandboxUser({ effectiveUid: 0, uidEnv: "1234" })
  assert.deepEqual(u, { uid: 1234, gid: 1234, source: "env" })
})

test("root refuses to drop to uid 0 (never 'drop' to root)", () => {
  assert.equal(resolveSandboxUser({ effectiveUid: 0, uidEnv: "0" }), null)
})

test("root + unresolvable named user falls back to null", () => {
  // A user name that cannot exist on any host → id(1) fails → null, so the
  // caller keeps same-uid behaviour rather than crashing.
  const u = resolveSandboxUser({ effectiveUid: 0, uidEnv: "pond-sandbox-definitely-not-a-real-user-xyz" })
  assert.equal(u, null)
})

test("root + no config resolves the default named account or degrades to null", () => {
  // On a host without a 'pond-sandbox' user (the common dev/CI case even if it
  // were root) this resolves to null; on a host that has one it resolves to a
  // non-root uid via source "name". Either is acceptable — assert the contract.
  const u = resolveSandboxUser({ effectiveUid: 0 })
  if (u !== null) {
    assert.equal(u.source, "name")
    assert.notEqual(u.uid, 0)
    assert.equal(typeof u.gid, "number")
  } else {
    assert.equal(u, null)
  }
})

test("DEFAULT_SANDBOX_USER is the documented named account", () => {
  assert.equal(DEFAULT_SANDBOX_USER, "pond-sandbox")
})
