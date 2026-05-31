// Abuse scoring for runaway capsules.
//
// cgroups CAP a capsule's CPU (cpu.max), memory (memory.max) and pids, but a
// capsule pinned AT its cap forever is a sustained denial-of-fairness: it burns
// its full share continuously, degrading the box for every neighbour even though
// no single limit is ever "exceeded" and nothing crashes. Quotas and per-IP rate
// limits only reject requests/creates — the worker keeps running and consuming
// CPU. This module turns per-capsule CPU samples into an auto-kill decision so a
// runaway/DoS capsule is taken down without a manual operator step.
//
// Pure functions only (no fs / no timers) so the policy is unit-testable on any
// platform, even though the cgroup samples that feed it only exist on a
// delegated Linux cgroup v2 host.

export interface CpuSample {
  cpuUsageSeconds: number
}

// Fraction of ONE CPU the capsule consumed between two cumulative samples.
// 1.0 == a full core for the whole interval. Returns 0 for a missing sample or a
// counter reset (the cgroup is recreated on respawn, so usage drops), ensuring a
// freshly (re)booted capsule never scores on its first interval.
export function cpuFractionOverInterval(
  prev: CpuSample | null | undefined,
  cur: CpuSample | null | undefined,
  intervalSeconds: number,
): number {
  if (!prev || !cur || !(intervalSeconds > 0)) return 0
  const delta = cur.cpuUsageSeconds - prev.cpuUsageSeconds
  if (!Number.isFinite(delta) || delta < 0) return 0
  return delta / intervalSeconds
}

// Advance a capsule's CPU-breach streak and decide whether to kill it.
// killPercent <= 0 disables the policy (streak pinned at 0, never kills). A
// capsule is killed only once it has held at/above the threshold for
// `sustainedSweeps` CONSECUTIVE intervals, so a single spike never trips it; any
// interval below the threshold resets the streak to 0.
export function scoreCpuAbuse(
  cpuFraction: number,
  prevStreak: number,
  killPercent: number,
  sustainedSweeps: number,
): { streak: number; kill: boolean } {
  if (!(killPercent > 0)) return { streak: 0, kill: false }
  if (cpuFraction * 100 >= killPercent) {
    const streak = prevStreak + 1
    return { streak, kill: streak >= Math.max(1, sustainedSweeps) }
  }
  return { streak: 0, kill: false }
}
