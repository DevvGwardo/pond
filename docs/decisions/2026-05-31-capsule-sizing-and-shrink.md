# Decision: Per-Capsule Resource Sizing & "Run Super Small" Optimization Map

**Date:** 2026-05-31
**Status:** Levers 1 & 2 landed (2026-05-31); Lever 4 awaiting operator go-ahead; Levers 3 & 5 future
**Authored:** analysis pass + Codex second-brain review

---

## 1. Context: why pond is not "free like Vercel"

The recurring question — _"why can Vercel host thousands of sites for free, and how small can a pond deploy get?"_ — has a reframing answer:

- **Vercel's free tier is mostly static.** Most sites people deploy are static frontends: files on a CDN (storage + bandwidth), **zero compute at rest**. That's the trick — nothing is _running_.
- **Vercel's dynamic code is scale-to-zero + V8 isolates.** Edge Functions are isolates (the Cloudflare Workers model): many tenants share one OS process, ~3–5 MB each, sub-ms cold start, billed per CPU-ms.

**Pond is a different animal.** Every deploy is **one full OS process** — `src/commands/host.ts` `fork()`s a Node child running a bundled Hono app + `better-sqlite3` + local-disk blobs (`host.ts:1089`). This buys real per-tenant SQLite, OAuth, AI, an egress firewall, and an fs sandbox — features Vercel functions don't have at rest — but it costs a whole process per site. Pond is a tiny self-hosted PaaS, not a CDN. It can get **dramatically smaller**, but not "free" the same way.

## 2. What we allocate per deploy today

From `src/host/control-db.ts` (`DEFAULT_QUOTA`) and `src/host/cgroup.ts`:

| Knob                                | Default tier               | Free tier |
| ----------------------------------- | -------------------------- | --------- |
| Heap cap (`--max-old-space-size`)   | **256 MB**                 | 128 MB    |
| CPU (cgroup `cpu.max`)              | **50%** of 1 core          | 25%       |
| Disk cap                            | 512 MB                     | 128 MB    |
| Bundle cap                          | 64 MB                      | 16 MB     |
| cgroup `memory.max` (hard OOM kill) | quota **+128 MB** = 384 MB | 256 MB    |
| `pids.max`                          | 256                        | 256       |

Production runs **`POND_MAX_ACTIVE_CAPSULES=8`** and **`POND_CAPSULE_IDLE_TIMEOUT=15m`** (scale-to-zero; slept capsules re-`fork()` on the next request).

### The quota is mostly headroom — the real cost is the Node-process tax

Measured RSS floors on the dev box (`node --test` host, current Node):

```
bare Node                     38.0 MB RSS
+ better-sqlite3 + open DB     45.6 MB RSS
+ hono                         46.2 MB RSS  (+2.9 over node+sqlite)
+ jose                         49.5 MB RSS  (+6.2)
+ arctic                       48.4 MB RSS  (+5.1)
+ esbuild                      48.1 MB RSS  (+4.8)   ← was loaded in every capsule!
full runtime dep set           52.9 MB RSS  ← per-capsule floor before app data
```

So the true cost per _active_ deploy is **~50 MB of Node-process tax**, not 256 MB. The heap cap rarely binds; it exists to OOM-kill a runaway. 8 active capsules ≈ **0.4 GB floor**, up to ~3 GB at the hard ceiling. **Idle deploys cost ~$0** (slept) — that part already mirrors Vercel.

## 3. Optimization ladder (ranked by ROI)

### 🥇 Lever 1 — Static-only deploy path ✅ LANDED (2026-05-31)

**Implemented** as an explicit opt-in: `capsule({ static: true })`. The host static-parses the flag (`extractCapsuleMeta`, same machinery as `public`), stores `isStatic` on the deploy record, skips `forkDeploy` at create/redeploy, and serves the prebuilt `client.html` straight from disk in the request path (`serveStaticDeploy`) — guarded by `runningChildren.has(deployId)` so the dynamic hot path pays nothing. `/api/*` on a static deploy 404s; a `static: true` deploy with no `client/index.tsx` is rejected at build. The WebSocket-upgrade path is guarded too. E2E proof in `test/host-static-deploy.test.mjs` — incl. `pond_host_capsules_active 0` (no worker forked). **Result: ~50 MB → ~0 MB per static site; unbounded count; exempt from `POND_MAX_ACTIVE_CAPSULES`.**

Original design notes (now realized):

Most things shipped (landing pages) are static. Today pond **forces a Node process even for them**: `server/index.ts` is required (`host.ts:152`) and the client is served _by_ that process. A static deploy should **never fork** — serve `client.html` straight from the host / a fronting Caddy / the cloudflared tunnel already in production. → **~50 MB → ~0 MB** per static site, unbounded count. This is the change that most closely reproduces "the Vercel feel."

**Design constraints (Codex-verified):**

- **"No queries/mutations/endpoints" ≠ static-safe.** A `server/index.ts` can still do work in custom endpoints, `fetch`, or blob serving. Detection must be **conservative**: an explicit opt-in (e.g. `capsule({ static: true })` or a deploy with _no_ `server/index.ts` once that requirement is relaxed for the static path), **not** an inference from an empty handler map.
- **Only static artifact today is `client.html`** (built from `client/index.tsx`). The static path serves exactly that plus `/api/blob/*` if blobs are kept; anything dynamic disqualifies it.
- Auth, AI, SQLite, rate-limit, metrics — all become unavailable on a static deploy _by definition_. That's the trade the user opts into.

**Sketch:** at deploy time, classify the deploy as `static | dynamic`. For `static`, write only `client.html` (+ assets) to the deploy dir and register it in the host router as a file-served route — no worker entry in `runningChildren`, no quota row needed, exempt from `POND_MAX_ACTIVE_CAPSULES`.

### 🥈 Lever 2 — Shrink the per-process baseline ✅ LANDED (2026-05-31)

`src/runtime.ts` eagerly imported `esbuild` and `arctic` at module top level, so **every capsule worker carried both** even though the worker only ever runs a _pre-built_ bundle (via `createRuntimeFromDeployBundle`) and the typical capsule configures no OAuth.

Changes (all behavior-neutral; 245/245 tests pass):

- **`esbuild` → dynamic `import()`** inside `createRuntime()` and `buildForDeploy()` (the build-only paths). The hosted worker never builds, so it no longer loads esbuild. **~5 MB/capsule saved, always.**
- **`arctic` → lazy** via a cached `loadArctic()` + `getGoogle()`/`getGitHub()` factories; loaded only when an OAuth route is hit on a configured capsule. The common no-OAuth capsule never imports it. **~5 MB/capsule saved** for non-OAuth deploys.
- **`jose` left static — deliberately.** It runs on the every-request session path (`resolveAuth`), so lazy-loading saves nothing once traffic arrives, and scale-to-zero already reclaims truly-idle capsules. Adding an `await import()` to the hot path would be churn for no gain.
- **AI providers were already lazy** (plain `fetch`, no library import).

Net: the no-OAuth capsule floor drops ~52.9 MB → ~43 MB (**~19%**) with zero feature loss.

### 🥉 Lever 3 — Aggressive scale-to-zero + warm process pool — ⚠️ REVISED (do not pursue the naive pool)

The original idea: drop idle timeout 15m → ~60–120 s and hold a pool of **pre-forked blank Node processes** to amortize the ~38 MB Node-init cost on cold start.

**Investigation finding (2026-05-31):** the warm pool is **not** a clean win. Per-deploy filesystem scoping (`--permission --allow-fs-read=${deployDir}` / `--allow-fs-write=${deployDir}`) is baked into the worker's `execArgv` at **fork time** (`host.ts` ~line 1054) and is immutable once the process is launched. A pre-forked "blank" process doesn't yet know which deploy it will serve, so it cannot carry the correct fs scoping — retro-fitting it would mean launching pool workers _without_ per-deploy `--allow-fs-*`, which weakens the exact sandbox boundary the model depends on. This is the **same** security-boundary tension as Lever 5 (isolates), just smaller. So the naive process pool is off the table.

What remains safe and cheap here is purely an **ops knob**: lower `POND_CAPSULE_IDLE_TIMEOUT` (e.g. 15m → 2–5m) to free active slots sooner, accepting more frequent cold starts (~Node-init + bundle import + DB open per wake). No warm pool, no code change — just config on the host. A genuinely faster cold start would need a different isolation primitive (snapshots / a brokered sandbox), which is v2 territory alongside Lever 5.

### Lever 4 — Tune the default quotas/timeouts (HOLD; touches LIVE prod)

See §4. **Recommendation: hold.** The only safe code-free knob is the idle timeout (Lever 3's ops note). The default heap **must not** drop to 128 MB until request/response bodies stream to disk instead of buffering in memory (blob `arrayBuffer()` → `Buffer.from`, `json()`), or uploads will OOM-kill capsules — and even then the win is marginal because the ~43–50 MB Node-process tax, not the heap cap, is what dominates. Do not ship without operator confirmation.

### ❌ Lever 5 — V8 isolates (many tenants / one process) — NOT recommended now

The "true Cloudflare" move. But it is a near-total rewrite that **fights pond's core security model**: the OS process _is_ the isolation boundary (sealed `process.dlopen`, patched `net.Socket.connect` egress block, Node `--permission` fs scoping, bwrap, cgroups — see `deploy-worker.ts`). And `better-sqlite3` is a native addon that **cannot run inside `isolated-vm`** — every DB call would have to be brokered across the isolate membrane. High effort, high risk. Documented as a possible v2; not pursued.

## 4. Proposed quota changes (Lever 4) — REQUIRES SIGN-OFF

| Change                                                                    | Rationale                                                                                                                                                                                      | Risk                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Keep default heap **256 MB** (do **not** drop to 128)                     | `runtime.ts` buffers full request/response bodies in memory — blob uploads (`arrayBuffer()` → `Buffer.from`) and `json()` parsing. A 128 MB default would OOM-kill capsules on modest uploads. | — (this is a "don't") |
| Route lightweight sites to the existing **free tier (128/25)** explicitly | The 128 MB tier already exists; use it for static-ish/low-need deploys instead of lowering the global default.                                                                                 | Low                   |
| Consider idle timeout **15m → 2–5m**                                      | Frees active slots faster; pairs with Lever 3's warm pool to keep cold starts cheap. Without the pool, expect more cold-start latency.                                                         | Medium (UX)           |

**The one firm "don't":** lowering the **default** `maxMemoryMb` to 128 is unsafe given current in-memory body buffering. Fix the buffering (stream uploads to disk) _first_ if a lower default is desired.

## 5. Bottom line

- Deploys **can** be small — the real cost is ~50 MB/process, not 256 MB, and idle ones already cost nothing.
- The dramatic win is **not isolates — it's not running a process at all for static sites** (Lever 1), plus the baseline trim already landed (Lever 2).
- Isolates are a tempting trap that would dismantle the security model for a memory win Levers 1–3 largely deliver at a fraction of the risk.
