// Per-capsule cgroup v2 resource isolation.
//
// The control plane forks each deploy as a child Node process. Without limits,
// one capsule in a hot loop or a memory balloon degrades every other capsule on
// the box — the direct "one user affects another" failure mode. When the host
// runs with --capsule-cgroup-root pointing at a delegated cgroup v2 subtree,
// every worker is placed in its own child cgroup with cpu.max / memory.max /
// pids.max bounds the kernel enforces.
//
// Everything here is best-effort and a no-op when the platform isn't a
// suitably-delegated Linux cgroup v2 host (e.g. macOS dev, or a box that hasn't
// run deploy/setup-capsule-isolation.sh). The probe must pass before any of the
// apply/remove calls run, so a misconfigured host degrades to the prior
// behaviour (only --max-old-space-size) rather than failing to boot capsules.

import * as fs from "node:fs"
import * as path from "node:path"

export interface CapsuleCgroupLimits {
  cpuMax: string // cgroup cpu.max: "<quota_us> <period_us>"
  memoryMax: string // cgroup memory.max: bytes
  pidsMax: string // cgroup pids.max: count
}

// 100ms scheduling period — the cgroup v2 default. quota_us / period_us is the
// fraction of one CPU the cgroup may consume.
export const CGROUP_PERIOD_US = 100_000

// Hard ceiling on processes/threads a capsule may spawn — blunts fork bombs.
export const CAPSULE_PIDS_MAX = 256

// memory.max headroom above the V8 heap cap (--max-old-space-size). The heap
// cap should be what bounds normal usage; memory.max exists to OOM-kill a
// genuinely runaway capsule (native allocations, buffers) without nuisance
// kills of a process merely near its heap limit.
export const MEMORY_OVERHEAD_MB = 128

export function cgroupLimitsFor(quota: { maxCpuPercent: number; maxMemoryMb: number }): CapsuleCgroupLimits {
  const cpuPct = Number.isFinite(quota.maxCpuPercent) && quota.maxCpuPercent > 0 ? quota.maxCpuPercent : 100
  // Floor at 1ms so a tiny percent never rounds to 0 (which cgroup rejects).
  const quotaUs = Math.max(1000, Math.round((cpuPct / 100) * CGROUP_PERIOD_US))
  const memMb = Number.isFinite(quota.maxMemoryMb) && quota.maxMemoryMb > 0 ? quota.maxMemoryMb : 256
  const memBytes = (memMb + MEMORY_OVERHEAD_MB) * 1024 * 1024
  return {
    cpuMax: `${quotaUs} ${CGROUP_PERIOD_US}`,
    memoryMax: String(memBytes),
    pidsMax: String(CAPSULE_PIDS_MAX),
  }
}

function controllerSet(file: string): Set<string> {
  return new Set(
    fs
      .readFileSync(file, "utf-8")
      .trim()
      .split(/\s+/)
      .filter((c) => c.length > 0),
  )
}

// Returns the validated root if `root` is a cgroup v2 directory that has cpu,
// memory and pids both available and delegated to children, AND we can create
// and remove a child cgroup there. Otherwise null (isolation disabled).
export function probeCapsuleCgroup(root: string | undefined | null): string | null {
  if (!root) return null
  try {
    const available = controllerSet(path.join(root, "cgroup.controllers"))
    if (!available.has("cpu") || !available.has("memory") || !available.has("pids")) return null
    // Controllers must be enabled in subtree_control or child cgroups can't use
    // them. setup-capsule-isolation.sh writes "+cpu +memory +pids" here.
    const delegated = controllerSet(path.join(root, "cgroup.subtree_control"))
    if (!delegated.has("cpu") || !delegated.has("memory") || !delegated.has("pids")) return null
    const probeDir = path.join(root, ".pond-cgroup-probe")
    fs.mkdirSync(probeDir, { recursive: true })
    fs.rmdirSync(probeDir)
    return root
  } catch {
    return null
  }
}

export function capsuleCgroupDir(root: string, deployId: string): string {
  return path.join(root, `capsule-${deployId}`)
}

// Move the calling (manager) process into a leaf cgroup under root. Two reasons:
// (1) cgroup v2's "no internal processes" rule — root can only enable
// controllers for its children once it holds no processes of its own; and
// (2) forked workers inherit this leaf, so migrating them to sibling
// capsule-<id> cgroups stays inside the delegated subtree (no cross-tree move,
// which an unprivileged delegated manager isn't permitted to do). Best-effort:
// where it fails (e.g. the manager isn't cgroup-delegated) per-capsule limits
// simply won't bind, and applyCapsuleCgroup reports that per deploy.
export function joinManagerCgroup(root: string): boolean {
  const dir = path.join(root, "manager")
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "cgroup.procs"), String(process.pid))
    return true
  } catch {
    return false
  }
}

// Create the capsule's cgroup, write its limits, and move the worker pid into
// it. Returns true only if the pid was successfully placed (the point at which
// the limits actually bind). Writing the limit files is best-effort — a kernel
// without one knob shouldn't sink the others.
export function applyCapsuleCgroup(root: string, deployId: string, pid: number, limits: CapsuleCgroupLimits): boolean {
  const dir = capsuleCgroupDir(root, deployId)
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const [file, value] of [
      ["cpu.max", limits.cpuMax],
      ["memory.max", limits.memoryMax],
      ["pids.max", limits.pidsMax],
    ] as const) {
      try {
        fs.writeFileSync(path.join(dir, file), value)
      } catch {
        // controller knob missing/denied — leave it unbounded rather than fail
      }
    }
    fs.writeFileSync(path.join(dir, "cgroup.procs"), String(pid))
    return true
  } catch {
    return false
  }
}

// Remove the capsule's cgroup once its worker has exited. rmdir only succeeds on
// an empty cgroup, so callers must stop the worker first; a non-empty/missing
// dir is ignored.
export function removeCapsuleCgroup(root: string, deployId: string): void {
  try {
    fs.rmdirSync(capsuleCgroupDir(root, deployId))
  } catch {
    // already gone, or still has procs — best effort
  }
}
