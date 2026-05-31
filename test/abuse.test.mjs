// Unit tests for the CPU-abuse scoring policy (P1 item 6). The cgroup sampling
// that feeds it is Linux-only, but the decision logic is pure and tested here.

import { test } from "node:test"
import assert from "node:assert/strict"

import { cpuFractionOverInterval, scoreCpuAbuse } from "../src/host/abuse.js"

test("cpuFractionOverInterval computes core-fraction from cumulative samples", () => {
  // 30 CPU-seconds burned over a 60s interval = 0.5 of a core.
  assert.equal(cpuFractionOverInterval({ cpuUsageSeconds: 10 }, { cpuUsageSeconds: 40 }, 60), 0.5)
  // A full core for the whole interval.
  assert.equal(cpuFractionOverInterval({ cpuUsageSeconds: 0 }, { cpuUsageSeconds: 60 }, 60), 1)
})

test("cpuFractionOverInterval returns 0 for missing samples and counter resets", () => {
  assert.equal(cpuFractionOverInterval(null, { cpuUsageSeconds: 5 }, 60), 0)
  assert.equal(cpuFractionOverInterval({ cpuUsageSeconds: 5 }, null, 60), 0)
  // Counter reset (cgroup recreated on respawn): cur < prev → 0, not negative.
  assert.equal(cpuFractionOverInterval({ cpuUsageSeconds: 100 }, { cpuUsageSeconds: 2 }, 60), 0)
  // Bad interval.
  assert.equal(cpuFractionOverInterval({ cpuUsageSeconds: 0 }, { cpuUsageSeconds: 60 }, 0), 0)
})

test("scoreCpuAbuse kills only after sustained breaches; a spike resets", () => {
  const percent = 90
  const sweeps = 3

  // Below threshold → streak stays 0, never kills.
  assert.deepEqual(scoreCpuAbuse(0.5, 0, percent, sweeps), { streak: 0, kill: false })

  // Climb to the threshold over consecutive sweeps.
  let s = scoreCpuAbuse(0.95, 0, percent, sweeps)
  assert.deepEqual(s, { streak: 1, kill: false })
  s = scoreCpuAbuse(0.95, s.streak, percent, sweeps)
  assert.deepEqual(s, { streak: 2, kill: false })
  s = scoreCpuAbuse(0.95, s.streak, percent, sweeps)
  assert.deepEqual(s, { streak: 3, kill: true }, "kills on the 3rd consecutive breach")

  // A single dip below threshold resets the streak.
  const reset = scoreCpuAbuse(0.1, 2, percent, sweeps)
  assert.deepEqual(reset, { streak: 0, kill: false })
})

test("scoreCpuAbuse is disabled when killPercent <= 0", () => {
  assert.deepEqual(scoreCpuAbuse(10, 100, 0, 1), { streak: 0, kill: false })
  assert.deepEqual(scoreCpuAbuse(10, 100, -5, 1), { streak: 0, kill: false })
})
