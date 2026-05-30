// Scale-to-zero decision logic for hosted capsules. Pure and dependency-free so
// it unit-tests without booting a host: given the current activity bookkeeping,
// it returns the deploy ids whose workers should be stopped (slept). The next
// request for a slept deploy re-boots it via the host's on-demand wake path
// (ensureBooted), so sleeping an idle capsule costs nothing but a cold start.

export interface IdleEvictionInput {
  /** Current time in epoch ms (the caller passes Date.now()). */
  now: number
  /** Sleep a capsule after this many ms with no activity. <= 0 disables eviction. */
  idleTimeoutMs: number
  /** Deploy ids of capsules currently resident. */
  running: Iterable<string>
  /** Last proxied request (or boot) per deploy, epoch ms. */
  lastActivityAt: Map<string, number>
  /** Open WebSocket connections per deploy. A capsule with any open socket is
   *  never slept, so a long-lived but quiet stream is not cut mid-connection. */
  liveSockets?: Map<string, number>
  /** Deploys mid-boot — skip them so a just-woken capsule isn't immediately slept. */
  booting?: { has(id: string): boolean }
}

export function selectIdleDeploys(input: IdleEvictionInput): string[] {
  const { now, idleTimeoutMs, running, lastActivityAt, liveSockets, booting } = input
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return []
  const evict: string[] = []
  for (const id of running) {
    if (booting?.has(id)) continue
    if ((liveSockets?.get(id) ?? 0) > 0) continue
    // A missing stamp means we never recorded activity for a resident capsule;
    // treat it as fully idle (0) so a stale entry is reclaimed rather than pinned.
    const last = lastActivityAt.get(id) ?? 0
    if (now - last >= idleTimeoutMs) evict.push(id)
  }
  return evict
}
