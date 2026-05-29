# Decision: Capsule Filesystem Isolation Gap & Remediation

**Date:** 2026-05-29
**Status:** Accepted
**Authored:** by the WR2 task

---

## 1. Context: the residual filesystem-isolation gap

Pond's Docker deploy model runs all capsules as forked Node workers sharing **uid 1000** inside one non-root container (`cap_drop: ALL`, `no-new-privileges`). Filesystem isolation between tenants rests entirely on Node's `--permission` flag — the worker is spawned with:

```
--permission --allow-fs-read=<deployDir>,<pondSrc>,<pondNodeModules>
             --allow-fs-write=<deployDir> --allow-addons
```

`src/host/deploy-worker.ts`::`installSandboxHardening()` already seals two native escape hatches before capsule code executes:

- `process.dlopen` — prevents loading new native addons
- `better-sqlite3.prototype.loadExtension` — prevents loading SQLite extensions

However, `better-sqlite3` is **pre-warmed** (the native binding is loaded via a throw-away `new (":memory:")` at hardening time) so that the runtime's own `ctx.db` usage works. The residual gap is a **confused-deputy**: the pre-warmed native binding can `open()` files in native code that `--permission` does not mediate. The exact boundary was measured (see §5): `new Database('<outside>')` _is_ blocked by `--permission` (better-sqlite3 does a JS-level `fs` pre-check), but **`ATTACH DATABASE '<outside>'` is not** — it opens a second file purely natively and was demonstrated reading a sibling tenant's SQLite db. `VACUUM INTO` / `backup()` are the equivalent native _write_ primitives.

In short: the `--permission` model is a JS-layer speed bump, and `ATTACH` (plus `VACUUM INTO` / `backup`) on the pre-warmed `better-sqlite3` binding is the one remaining way for a capsule to reach `libc open()` on arbitrary paths without triggering a sealed dlopen or loadExtension.

---

## 2. Options evaluated

### (A) In-process V8 / Node isolate

Execute capsule code in a V8 isolate within the same Node process. **Rejected:** native code (like the `better-sqlite3` binding) shares the process filesystem namespace regardless of JS-isolate boundaries. An isolate does not confine `libc open()`, so it does not close this hole.

### (B) Cloudflare Workers / Sandbox runtime

Port capsule execution to a different runtime (Cloudflare Workers, or another sandboxed JS environment). **Rejected:** this is a different deployment target, breaks the local `ctx.db` interface and the per-capsule cgroup/nftables egress firewall, and introduces vendor lock-in. It is not a "sandbox mode" for the existing Docker deployment — it is a rewrite.

### (C) Firecracker microVM

Run each capsule in its own Firecracker microVM. **Rejected:** requires `/dev/kvm` and a privileged jailer process (root or `CAP_SYS_ADMIN`), which constitutes a privilege regression from the current `cap_drop: ALL` posture. Also infeasible at capsule density on a 2 GB box.

### (D) bwrap (bubblewrap) inside the Docker container

Wrap each capsule worker with `bwrap` to create a per-capsule mount namespace from an allowlist (only the capsule's own deploy dir rw, pond runtime ro, system dirs ro — control.db, host-token, and sibling deploys are never bound). This is the structural kernel-boundary fix, and it already exists in the codebase (`src/host/capsule-fs-sandbox.ts`, `buildBwrapArgv`), verified on bare-metal Linux.

**Rejected for the Docker model — empirically blocked:**

```
# bwrap inside the container: unprivileged userns
docker run --security-opt seccomp=unconfined --cap-add=SYS_ADMIN \
  <image> bwrap --ro-bind / / -- true
# => bwrap: Can't make / slave: Permission denied
```

The container's locked mounts (Docker's overlay2 mount topology) prevent bwrap from making `/` a slave mount inside the child user namespace, even with seccomp disabled and `SYS_ADMIN` granted. The default Docker seccomp profile also blocks `unshare(CLONE_NEWUSER)` entirely. Both paths constitute a privilege regression from the current locked-down container posture and do not yield a working bwrap boundary. The bwrap mode remains available and tested for **bare-metal** deployments, where these constraints do not apply.

---

## 3. Governing constraints

The decision space is framed by hard constraints of the Docker deploy model:

- **No privilege regression.** The container runs non-root (uid 1000), `cap_drop: ALL`, `no-new-privileges: true`. Adding `SYS_ADMIN`, `--privileged`, or relaxing the seccomp profile to enable unprivileged user namespaces or mount manipulation would weaken the container→host boundary and is unacceptable.
- **Code-map constraint.** An out-of-process or remote worker (in a sibling container, gVisor sandbox, or microVM) loses access to the **local PID** needed for per-capsule cgroup caps (CPU/memory/PID limits) and the nftables egress firewall (which matches on socket cgroup membership). Replacing these with an external mechanism is a substantially larger effort.
- **Privilege-less hosts (Railway / managed PaaS).** On hosts that do not grant cgroup delegation or nftables capability, the OS-enforcement layer is already off, and the `--permission` model is the **only** tenant-isolation boundary. Closing the `better-sqlite3` native-open gap is load-bearing in that mode.

---

## 4. Decision

### (a) No kernel filesystem boundary in the Docker model — now

bwrap-in-Docker is empirically blocked by Docker's mount topology and seccomp profile, and the privilege/flag changes needed to unblock it would weaken the container→host boundary. **bwrap remains available and unchanged for bare-metal deployments** where unprivileged user namespaces and mount manipulation are available natively.

### (b) Close the residual native-open hole in pure JS

**Verified empirically** under the worker's exact flags (`--permission --allow-fs-read=<deployDir> --allow-addons`), the pre-warmed `better-sqlite3` binding exposes these vectors:

- `new Database('<outside>')` — **already blocked** by `--permission`: better-sqlite3 does a JS-level `fs` pre-check on construction, which the permission model intercepts.
- `ATTACH DATABASE '<outside>'` — **NOT blocked**. A capsule does `new Database(':memory:')` then `ATTACH DATABASE '/data/control.db'` (or a sibling deploy's db) and reads it; the attach opens the file purely in native code with no `--permission` check. _This is the real read-exfil_ and was demonstrated reading a sibling tenant's secret.
- `VACUUM INTO '<outside>'` / `db.backup('<outside>')` — native writes that can clobber arbitrary paths.

`installSandboxHardening()` (`src/host/deploy-worker.ts`) now closes these:

- **ATTACH is blocked outright.** `exec`/`prepare` are wrapped (the only entry points the SQLite tokenizer reaches; the literal keyword must pass through them, so the guard cannot be bypassed). Comments are stripped first to prevent masking/false-positives; capsules have no need for cross-database access.
- **VACUUM INTO is path-validated**, not blocked — pond's own `/__pond/db/backup` endpoint snapshots into the deploy dir, so an in-`cwd` target is allowed and any other target is rejected.
- **`backup(dest)` and the `Database` constructor are path-validated** against the deploy dir (constructor validation is belt-and-suspenders behind `--permission`, in case a future better-sqlite3 drops its JS pre-check).
- `loadExtension` and `process.dlopen` remain sealed as before.

Allowed root is `process.cwd()` captured at hardening time (workers run with `cwd` = the deploy dir). Verified by `test/capsule-sqlite-confinement.test.mjs` (ATTACH via `prepare`, via the raw runner, and comment-obfuscated; VACUUM INTO; constructor — all blocked, sibling secret never read) and the full suite (200/200, including the backup endpoint).

### (c) Heavyweight isolation deferred

Per-capsule sibling containers, gVisor, or a scoped-seccomp + userns spike for the Docker model are deferred as **future work**. They would require relaxing container privileges (a security regression) or a fundamentally different deployment architecture. These options should be enabled only behind an opt-in flag after a dedicated spike that validates the approach against the constraints in §3.

---

## 5. Empirical findings (reproducible)

The bwrap-in-Docker finding was reached via a matrix of Docker security flags against a stock Debian-based container running bwrap 0.8.0:

```bash
# default seccomp blocks unshare(CLONE_NEWUSER)
docker run --rm <image> bwrap --ro-bind / / -- true
# => bwrap: Creating new namespace failed: Operation not permitted

# unconfined seccomp, but unprivileged userns still needs a knob
docker run --rm --security-opt seccomp=unconfined <image> \
  bwrap --ro-bind / / -- true
# => bwrap: Can't make / slave: Permission denied

# even seccomp=unconfined + SYS_ADMIN hits the mount-topology wall
docker run --rm --security-opt seccomp=unconfined \
  --cap-add=SYS_ADMIN <image> bwrap --ro-bind / / -- true
# => bwrap: Can't make / slave: Permission denied
# (Docker's overlay2 mounts are locked in the child userns)

# bare-metal (outside Docker), for reference:
bwrap --ro-bind / / -- true
# => exit 0 (works with kernel.unprivileged_userns_clone=1)
```

The `capsule-fs-sandbox.ts` module (`buildBwrapArgv`, `SYSTEM_RO_PATHS`) and the IPC-through-bwrap mechanism (`NODE_CHANNEL_FD` inheritance via `spawn` with `ipc` stdio) were verified functional on bare-metal Linux and remain unchanged.
