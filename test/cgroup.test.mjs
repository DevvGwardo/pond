// Unit tests for the per-capsule cgroup helpers. The actual kernel enforcement
// can only be exercised on a delegated Linux cgroup v2 host, so here we cover
// the parts that ARE platform-independent: the limit-string arithmetic, and the
// guarantee that every entry point is a safe no-op when there's no valid cgroup
// root (the macOS / undelegated case the probe must reject).

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  cgroupLimitsFor,
  probeCapsuleCgroup,
  applyCapsuleCgroup,
  removeCapsuleCgroup,
  readCapsuleCgroupUsage,
  capsuleCgroupDir,
  CGROUP_PERIOD_US,
  CAPSULE_PIDS_MAX,
  MEMORY_OVERHEAD_MB,
} from "../src/host/cgroup.js"

test("cgroupLimitsFor maps percent → cpu.max quota/period", () => {
  const { cpuMax } = cgroupLimitsFor({ maxCpuPercent: 50, maxMemoryMb: 256 })
  assert.equal(cpuMax, `${CGROUP_PERIOD_US / 2} ${CGROUP_PERIOD_US}`)

  const full = cgroupLimitsFor({ maxCpuPercent: 100, maxMemoryMb: 256 })
  assert.equal(full.cpuMax, `${CGROUP_PERIOD_US} ${CGROUP_PERIOD_US}`)

  const overcommit = cgroupLimitsFor({ maxCpuPercent: 150, maxMemoryMb: 256 })
  assert.equal(overcommit.cpuMax, `${Math.round(1.5 * CGROUP_PERIOD_US)} ${CGROUP_PERIOD_US}`)
})

test("cgroupLimitsFor floors a tiny percent at a non-zero quota", () => {
  // cgroup rejects a 0 quota; a sub-1% request must still round up to >= 1000us.
  const { cpuMax } = cgroupLimitsFor({ maxCpuPercent: 0.0001, maxMemoryMb: 64 })
  const quotaUs = Number(cpuMax.split(" ")[0])
  assert.ok(quotaUs >= 1000, `quota ${quotaUs} should be floored at 1000us`)
})

test("cgroupLimitsFor adds memory headroom over the heap cap and sets pids", () => {
  const { memoryMax, pidsMax } = cgroupLimitsFor({ maxCpuPercent: 50, maxMemoryMb: 256 })
  assert.equal(memoryMax, String((256 + MEMORY_OVERHEAD_MB) * 1024 * 1024))
  assert.equal(pidsMax, String(CAPSULE_PIDS_MAX))
})

test("cgroupLimitsFor tolerates bogus quota values", () => {
  const { cpuMax, memoryMax } = cgroupLimitsFor({ maxCpuPercent: NaN, maxMemoryMb: -5 })
  // Falls back to 100% CPU and the 256MB default rather than emitting garbage.
  assert.equal(cpuMax, `${CGROUP_PERIOD_US} ${CGROUP_PERIOD_US}`)
  assert.equal(memoryMax, String((256 + MEMORY_OVERHEAD_MB) * 1024 * 1024))
})

test("probeCapsuleCgroup returns null for unset / non-cgroup paths", () => {
  assert.equal(probeCapsuleCgroup(null), null)
  assert.equal(probeCapsuleCgroup(""), null)
  assert.equal(probeCapsuleCgroup("/nonexistent/cgroup/root"), null)

  // A real directory that simply isn't a cgroup v2 tree (no cgroup.controllers).
  const dir = mkdtempSync(path.join(tmpdir(), "pond-cgroup-probe-"))
  try {
    assert.equal(probeCapsuleCgroup(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("probeCapsuleCgroup rejects a v2 tree whose delegation was stripped", () => {
  // The false-confidence case the host must NOT mistake for "cgroup v2 enabled":
  // controllers are AVAILABLE (cgroup.controllers) but NOT delegated to children
  // (cgroup.subtree_control is empty) — common after a container restart on the
  // systemd cgroup driver. Child cgroups then can't use cpu/memory/pids, so nft
  // rules keyed on cgroup membership match nothing. Probe must return null.
  const dir = mkdtempSync(path.join(tmpdir(), "pond-cgroup-stripped-"))
  try {
    writeFileSync(path.join(dir, "cgroup.controllers"), "cpu memory pids\n")
    writeFileSync(path.join(dir, "cgroup.subtree_control"), "\n") // delegation stripped
    assert.equal(probeCapsuleCgroup(dir), null)

    // And the inverse: controllers present AND delegated, but partial (missing
    // pids) is still rejected — all three must be delegated.
    writeFileSync(path.join(dir, "cgroup.subtree_control"), "cpu memory\n")
    assert.equal(probeCapsuleCgroup(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readCapsuleCgroupUsage is a safe no-op (null) with no cgroup files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pond-cgroup-usage-none-"))
  try {
    // No capsule-<id> dir exists → null, never throws (macOS/undelegated case).
    assert.equal(readCapsuleCgroupUsage(root, "deadbeef"), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readCapsuleCgroupUsage parses cpu.stat + memory.current", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pond-cgroup-usage-"))
  try {
    const dir = capsuleCgroupDir(root, "deadbeef")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "cpu.stat"),
      "usage_usec 2500000\nuser_usec 2000000\nsystem_usec 500000\nnr_periods 100\nnr_throttled 7\nthrottled_usec 1500000\n",
    )
    writeFileSync(path.join(dir, "memory.current"), "67108864\n")
    const usage = readCapsuleCgroupUsage(root, "deadbeef")
    assert.ok(usage, "expected usage object")
    assert.equal(usage.cpuUsageSeconds, 2.5)
    assert.equal(usage.memoryBytes, 67108864)
    assert.equal(usage.nrThrottled, 7)
    assert.equal(usage.throttledSeconds, 1.5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("applyCapsuleCgroup / removeCapsuleCgroup never throw (probe is the gate)", () => {
  // applyCapsuleCgroup is only reached for a root that already passed the
  // probe, so the contract that matters off a real cgroup fs is simply: never
  // throw, always return a boolean. (On a plain dir the writes land as regular
  // files and it returns true; that's harmless because the probe rejects plain
  // dirs upstream.)
  const root = mkdtempSync(path.join(tmpdir(), "pond-cgroup-apply-"))
  try {
    const ok = applyCapsuleCgroup(
      root,
      "deadbeef",
      process.pid,
      cgroupLimitsFor({ maxCpuPercent: 50, maxMemoryMb: 128 }),
    )
    assert.equal(typeof ok, "boolean")
    assert.doesNotThrow(() => removeCapsuleCgroup(root, "deadbeef"))
    assert.equal(capsuleCgroupDir(root, "deadbeef"), path.join(root, "capsule-deadbeef"))
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  }
})
