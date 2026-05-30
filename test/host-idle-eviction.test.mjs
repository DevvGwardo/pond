// Tests for the scale-to-zero eviction decision. The choice of which capsules
// to sleep is pure (no timers, no child processes), so it runs anywhere and
// exercises every branch directly instead of waiting on the 60s sweep loop.

import { test } from "node:test"
import assert from "node:assert/strict"

import { selectIdleDeploys } from "../src/host/idle.js"

test("selectIdleDeploys: disabled when idleTimeoutMs <= 0", () => {
  const lastActivityAt = new Map([["a", 0]])
  assert.deepEqual(
    selectIdleDeploys({ now: 1_000_000, idleTimeoutMs: 0, running: ["a"], lastActivityAt }),
    [],
    "0 disables eviction",
  )
  assert.deepEqual(
    selectIdleDeploys({ now: 1_000_000, idleTimeoutMs: -5, running: ["a"], lastActivityAt }),
    [],
    "negative disables eviction",
  )
})

test("selectIdleDeploys: evicts only deploys idle at or past the timeout", () => {
  const now = 1_000_000
  const idle = 15 * 60 * 1000
  const lastActivityAt = new Map([
    ["stale", now - idle - 1], // just past the window → evict
    ["exactly", now - idle], // exactly at the window → evict (>=)
    ["fresh", now - 1000], // recent → keep
  ])
  const out = selectIdleDeploys({
    now,
    idleTimeoutMs: idle,
    running: ["stale", "exactly", "fresh"],
    lastActivityAt,
  }).sort()
  assert.deepEqual(out, ["exactly", "stale"])
})

test("selectIdleDeploys: never sleeps a capsule with an open socket", () => {
  const now = 1_000_000
  const idle = 1000
  const lastActivityAt = new Map([["ws", now - 999_999]]) // long idle
  const liveSockets = new Map([["ws", 1]])
  assert.deepEqual(
    selectIdleDeploys({ now, idleTimeoutMs: idle, running: ["ws"], lastActivityAt, liveSockets }),
    [],
    "open socket pins the capsule",
  )
  liveSockets.set("ws", 0)
  assert.deepEqual(
    selectIdleDeploys({ now, idleTimeoutMs: idle, running: ["ws"], lastActivityAt, liveSockets }),
    ["ws"],
    "evictable once the last socket closes",
  )
})

test("selectIdleDeploys: skips a capsule that is mid-boot", () => {
  const now = 1_000_000
  const idle = 1000
  const lastActivityAt = new Map([["b", now - 999_999]])
  const booting = new Set(["b"])
  assert.deepEqual(
    selectIdleDeploys({ now, idleTimeoutMs: idle, running: ["b"], lastActivityAt, booting }),
    [],
    "a just-woken capsule is not immediately slept",
  )
})

test("selectIdleDeploys: a missing activity stamp counts as fully idle", () => {
  const now = 1_000_000
  const idle = 1000
  assert.deepEqual(selectIdleDeploys({ now, idleTimeoutMs: idle, running: ["x"], lastActivityAt: new Map() }), ["x"])
})
