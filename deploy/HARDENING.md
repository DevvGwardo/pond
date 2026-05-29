# Pond host hardening & isolation rollout

This is the operational runbook for the multi-tenant isolation work. Several
steps touch the **live host** (cgroups, nftables, container user) and **cannot
be verified on a macOS dev box** — apply them on the Linux host and verify there.

The trust model is now **uniform isolation**: every capsule runs in the Node
permission sandbox regardless of claim status. Claiming a deploy changes
ownership and quota, _not_ isolation. The control-plane and quota fixes ship
on by default; the network and container-hardening steps below are an opt-in
rollout because they have production blast radius.

---

## 1. Control-plane fixes (already active, no action needed)

These are in the code and covered by the test suite:

- First anonymous claimer can no longer self-mint an admin account.
- The host token is no longer reprinted to stdout/`docker logs` after first run.
- The claim token is rotated on every claim — a leaked pre-claim token dies.
- `publicInspect` exposes read-only inspect only; backup/restore/logs require
  the claim token.
- Uniform Node `--permission` sandbox for all capsules.
- Native-code lockdown in every worker (`installSandboxHardening`): `process.dlopen`
  and better-sqlite3's `loadExtension` are sealed before any capsule code runs, so
  a capsule can't load a native addon / SQLite extension to bypass `--permission`'s
  filesystem limits (libc `open()` is not mediated by the permission model). The
  runtime's own better-sqlite3 binding is warmed first, so legitimate `ctx.db` use
  is unaffected. Realm escapes are denied separately: the worker runs without
  `--allow-worker` / `--allow-child-process`.
- better-sqlite3 file primitives (`ATTACH`, `VACUUM INTO`, `backup`, and opening
  an arbitrary file as the main db) are guarded at the **native prototype +
  constructor** layer, not only the JS `exec`/`prepare` wrappers. This closes the
  bypass where a capsule reaches the raw native handle (`db[cppdb]`) or the native
  constructor (`handle.constructor` / the cached addon) to skip the wrapper guard
  — e.g. `new handle.constructor('/data/control.db', …)` then a plain `SELECT`,
  which carries no `ATTACH` keyword for a SQL-text guard to catch. Every open is
  path-confined to the deploy dir. Still a JS speed bump (see §7), not a kernel
  boundary.
- Runtime disk watchdog stops a capsule that exceeds its disk quota; the
  `/__pond/db/restore` upload is bounded by the deploy's disk quota.
- Per-IP anonymous rate limiting prefers `CF-Connecting-IP` (unspoofable behind
  Cloudflare) over the client-settable `X-Forwarded-For`.

---

## 1b. Privilege-less hosts (Railway / managed PaaS): OS hardening is unavailable

§2–§6 below (cgroups, the nft egress firewall, the non-root-with-delegation
container, `bwrap`) all require **host-level privilege**: a delegated cgroup v2
subtree, the ability to load nftables rules, and unprivileged user namespaces.
A managed PaaS like **Railway** grants none of these — the container runs
without `CAP_NET_ADMIN`, `/sys/fs/cgroup` is not delegated, and `nft -f` /
`bwrap` cannot take effect. On such a host the entire OS-enforcement layer is
**off**, and the startup banner says so (`capsule isolation: cgroup limits OFF`,
the `⚠ … match NOTHING` egress warning, `capsule fs isolation: OFF`).

What still holds on a privilege-less host:

- **Phase 1 — resource & abuse caps (active, verified live).** The control-plane
  fixes in §1, the concurrency ceiling (`POND_MAX_ACTIVE_CAPSULES`), and the
  per-deploy daily request/mutation quotas (`POND_ANON_REQUESTS_PER_DAY` /
  `POND_ANON_MUTATIONS_PER_DAY`) are pure userspace and run anywhere. They bound
  blast radius (memory/OOM, CPU monopolization, request floods) without needing
  host privileges.
- **The Node `--permission` sandbox** is the _only_ tenant-isolation boundary in
  this mode — the same speed-bump described in §7, now load-bearing rather than
  defense-in-depth. A missed native-load surface or `--permission` being off
  (Node < 22) means a capsule could reach `control.db` and sibling secrets. The
  directly-reachable native escapes (better-sqlite3 native handle/constructor;
  UDP via `node:dgram`) are now sealed (§1), but egress is still restricted only
  at the JS layer — `fetch`/`net`/`dns`/`dgram` are shimmed, yet native code (or a
  Node internal that bypasses these JS entry points) can still reach the network.

**Phase 2 — isolate runtime (the structural fix for privilege-less hosts).**
Because the kernel boundaries can't be enabled on Railway, the path to running
_anonymous_ (untrusted) capsules safely there is to stop relying on the OS layer
and execute capsule code in an in-process isolate boundary instead. Until that
lands, treat anonymous capsules on a privilege-less host as protected by the JS
`--permission` layer only — appropriate for the current trust posture (resource
caps + permission sandbox), not for adversarial multi-tenant workloads that
assume a kernel boundary.

---

## 2. Per-capsule cgroup isolation (Linux host)

cgroups cap CPU/memory/pids per capsule **and** are what the egress firewall
matches on. Required before sealed/proxy egress is meaningful.

```bash
# On the host, as root, once:
sudo POND_CAPSULE_CGROUP_ROOT=/sys/fs/cgroup/pond POND_RUN_USER=node \
  deploy/setup-capsule-isolation.sh
```

Then set `POND_CAPSULE_CGROUP_ROOT=/sys/fs/cgroup/pond` in `deploy/.env`. The
`/sys/fs/cgroup` mount is already enabled in `docker-compose.yml`. The host logs
`capsule isolation: cgroup v2 enabled` when it takes effect.

> **⚠ Silent egress no-op.** The nft egress firewall matches on capsule **cgroup
> membership** (`socket cgroupv2 level 1 "pond"`). If cgroup isolation is OFF
> (this step skipped, wrong `POND_RUN_USER`, or delegation failed), a loaded
> `capsule-egress.nft` ruleset matches **nothing** — `nft -f` succeeds but
> capsules get unrestricted OS-level egress. Do NOT trust the firewall until you
> see `capsule isolation: cgroup v2 enabled` at startup; the host now prints a
> `⚠ ... match NOTHING` warning when egress is requested without cgroups. Verify
> with `nft list table inet pond` showing a nonzero `counter` on the drop rule
> under load.

**`POND_RUN_USER=node`** matters: the container now runs as the non-root `node`
user (see §3), and cgroup v2 delegation hands the subtree to that user so the
control plane can create per-capsule cgroups without root.

**Docker-compose path (systemd cgroup driver).** When Docker uses the systemd
cgroup driver, the compose service places the container under `pond.slice`
(`cgroup: host` + `cgroup_parent: pond.slice`) and points pond at
`POND_CAPSULE_CGROUP_ROOT=/sys/fs/cgroup/pond.slice`. Docker recreates
`pond.slice` root-owned on every container start and strips its delegation, so
delegation must be re-applied each time — not just at boot. Install
`pond-cgroup-watch.service` (see its header); it watches Docker for pond-host
start events and runs `pond-cgroup-delegate.sh`, which re-grants the slice to
uid 1000 **and purges stale per-capsule cgroups** left by the previous
container. The purge is essential: re-enabling controllers on a slice that still
has children makes the kernel re-create their `memory.max`/`pids.max`/`cpu.max`
root-owned, and the uid-1000 control plane then can't write them — workers get
placed but uncapped (`memory.max=max`). With the watcher, per-capsule caps
survive a `docker compose up -d` recreate with no reboot; verify after a
recreate that a `capsule-*` cgroup shows a real `memory.max`/`pids.max`.

## 3. Non-root container (Dockerfile)

The Dockerfile now runs as `node` (uid 1000) with `cap_drop: ALL` and
`no-new-privileges`. **Existing deployments**: the `pond-data` named volume was
created root-owned, so the non-root process can't write it until you chown it
once:

```bash
docker compose -f deploy/docker-compose.yml down
docker run --rm -v pond_pond-data:/data busybox chown -R 1000:1000 /data
docker compose -f deploy/docker-compose.yml up -d --build
```

Verify the host boots, serves `/api/health`, and can still create per-capsule
cgroups (no `could not place deploy … in a cgroup` errors in the logs).

## 4. Uniform egress: `sealed` then `proxy`

`--capsule-egress` / `POND_CAPSULE_EGRESS` controls outbound for **all**
capsules:

- **`open`** (default) — legacy: only anonymous-unclaimed capsules are
  network-restricted; claimed capsules keep full outbound network.
- **`sealed`** — no capsule may make outbound connections. Uniform isolation.
  **Will break any hosted app that calls an external API.** Only choose this if
  pond apps are not expected to make outbound requests.
- **`proxy`** — capsules reach only their per-deploy allowlist via the egress
  proxy. **Staged, not yet wired end-to-end** (see §5). The host refuses to
  start in this mode until that lands, rather than silently sealing capsules.

Apply the OS egress firewall (it is the real boundary; the JS layer is only a
speed bump):

```bash
# Edit deploy/capsule-egress.nft: set the proxy port (default 8788) or delete
# the proxy-allow line for fully-sealed.
sudo nft -f deploy/capsule-egress.nft
sudo nft list table inet pond     # verify
```

The nft ruleset now drops **new loopback** connections between capsules and to
the control plane (the prior `oifname lo accept` gap), allowing only:
established/related replies (so proxied inbound requests are answered) and new
loopback to the egress proxy port. Capsules share the host loopback, so this is
port-based, not per-capsule — true per-tenant network isolation needs network
namespaces (future work).

## 5. Completing `proxy` mode (remaining work)

The pieces are built and unit-tested (`src/host/egress-proxy.ts`,
`test/egress-proxy.test.mjs`, the `deploy_egress` control-db table + methods,
the nft rule). To finish end-to-end:

1. **Add `undici` as a dependency.** Node's global `fetch` does not honor
   `HTTP_PROXY`; the capsule worker must install an `undici` `ProxyAgent` as the
   global dispatcher. `undici` must be resolvable from the worker's
   `node_modules` (it is not bundled today).
2. **Worker wiring** (`src/host/deploy-worker.ts`): when an egress-proxy URL +
   per-deploy credential are provided, `setGlobalDispatcher(new ProxyAgent(url))`
   and keep the `net.Socket` deny so only proxied egress works. Fall back to
   deny-all (sealed) if `undici` is unavailable — never fail open.
3. **Host wiring** (`src/commands/host.ts`): start `startEgressProxy` when mode
   is `proxy`, its `resolve(deployId, secret)` backed by `controlDb.getEgress`
   (constant-time secret compare); mint a per-deploy egress secret on create;
   inject `HTTPS_PROXY`/`HTTP_PROXY` + `Proxy-Authorization` into
   `scopedEnvFor`; add `NO_PROXY` for the proxy address itself.
4. **Allowlist management API**: owner/admin-only endpoint to read/set a
   deploy's `deploy_egress` allowlist (`setEgressAllowlist`).
5. **Verify on the host**: an allowlisted host is reachable through the proxy; a
   non-allowlisted host is refused; with nft active, a direct connect (bypassing
   the proxy) is dropped at the OS layer.
6. Remove the startup gate in `host.ts` that currently rejects `proxy` mode.

## 6. Per-capsule filesystem isolation: `bwrap` (Linux host)

This is the structural fix for the filesystem half of the threat model — the
analogue of the nft egress firewall. The Node `--permission` model + native-code
lockdown (§1) is a JS-layer speed bump; `bwrap` is a kernel-enforced boundary.

`--capsule-fs-isolation` / `POND_CAPSULE_FS_ISOLATION`:

- **`off`** (default) — capsules are isolated only by the Node `--permission`
  model. One shared uid, one container; a missed native-load surface or a host
  on Node < 22 means a capsule can read `control.db` and sibling secrets.
- **`bwrap`** — each capsule worker is launched inside a
  [bubblewrap](https://github.com/containers/bubblewrap) mount namespace built
  from an **allowlist**: only the capsule's own deploy dir (rw) and the pond
  runtime + `node_modules` (ro) are bound, plus read-only system dirs for the
  node binary. `control.db`, the host-token file, and every sibling deploy dir
  live under the control-plane data dir, which is **never bound** — they do not
  exist in the capsule's filesystem at all. The `--permission` flags are kept
  inside the sandbox as defense-in-depth.

**Fail-closed.** `bwrap` mode requires Linux + the `bwrap` binary on `PATH`. If
either is missing the host **refuses to start** rather than silently booting
capsules unconfined (same rule as `proxy` egress). Install on Debian/Ubuntu:

```bash
sudo apt-get install -y bubblewrap
# Unprivileged user namespaces must be permitted (default on most distros):
sysctl kernel.unprivileged_userns_clone   # want 1, if the knob exists
```

Enable it:

```bash
# deploy/.env
POND_CAPSULE_FS_ISOLATION=bwrap
```

**Mechanism verified on Linux.** The two load-bearing claims were exercised
against real `bwrap` (0.8.0, Node 22) in a Linux container using the actual
`buildBwrapArgv` output:

- **Allowlist boundary** — from inside the namespace, `control.db`, the
  host-token file, and a sibling deploy dir all return `ENOENT`; the capsule's
  own deploy dir is readable + writable; the pond runtime is readable but
  `EROFS` (read-only). control.db et al. are not merely unreadable, they are
  absent.
- **IPC through bwrap** — a `spawn`ed `bwrap … node` child with `ipc` stdio
  successfully delivered a `booted` message to the parent, confirming
  `NODE_CHANNEL_FD` survives the bwrap exec. (See the note below.)

**Still verify on the actual host** (the container test used a stub worker, not
the real runtime):

1. Host boots and logs `capsule fs isolation: bubblewrap enabled`.
2. Deploy a real capsule and confirm it serves `/api/health` and its own
   `ctx.db` reads/writes still work — i.e. the real `deploy-worker` +
   native `better-sqlite3` + the `--permission` flags all function together
   under bwrap (the part the mechanism test did not cover).
3. Spot-check the boundary from inside a real capsule: `ls` the data-dir path →
   no `control.db` / `host-token` / sibling `deploys/<other-id>`; absolute-path
   read of another deploy → ENOENT.

> **IPC-through-bwrap note.** The control plane drives each worker over a Node
> IPC channel (the `boot`/`booted` messages). `fork` wires this automatically;
> in `bwrap` mode the host `spawn`s `bwrap` with the same `ipc` stdio so the
> channel fd (`NODE_CHANNEL_FD`) is inherited by the inner node. bwrap is not
> given `--args`, so it consumes no extra fds. This was confirmed working on
> Linux; if boots ever time out under `bwrap`, that fd inheritance is the first
> thing to check.

## 7. Known residual gaps

- **DNS / UDP / native-addon exfil.** The JS shim blocks `fetch`,
  `net.Socket.connect`, `node:dns` (lookup/resolve/Resolver), and `node:dgram`
  (UDP `send`/`connect`) — closing the no-native-code exfil paths (Node's
  `--permission` model does **not** gate the network, so UDP was otherwise wide
  open). It remains defense-in-depth, not the boundary: native code, or a
  Node-internal that bypasses these JS entry points (e.g. a low-level
  `process.binding` socket), can still reach the network. Off-box exfil is closed
  _for real_ only at the OS layer (nft drops 53 and all non-proxy egress).
- **Filesystem isolation between tenants** rests on the Node `--permission` model
  plus the native-code lockdown (§1) **when `--capsule-fs-isolation=off`** (the
  default). In that mode every capsule and the control plane share one uid in one
  container with **no OS-level filesystem boundary behind `--permission`** — if a
  future native-load surface is missed, or `--permission` is off (Node < 22, or
  `sandboxAvailable` false), a capsule can read the control DB and sibling
  deploys' secrets. The directly-reachable native better-sqlite3 escapes (raw
  handle + constructor) are sealed (§1); this gap is now about _unknown/future_
  native surfaces, not a known-open one. The kernel-enforced fix exists as an
  opt-in: set
  `--capsule-fs-isolation=bwrap` on a Linux host (§6). Treat the lockdown as the
  speed bump and bwrap as the real boundary, exactly as the JS network shim
  relates to the nft firewall. The bwrap mechanism (allowlist + IPC) is verified
  on Linux (§6); remaining work to make it the default: a full-runtime host smoke
  test (real worker + native `better-sqlite3` + `--permission` under bwrap), then
  a production soak before flipping the default.
- **Capsule-to-capsule on loopback** is closed for _new_ connections by the nft
  rule, but capsules still share a network namespace. Per-tenant netns (or
  microVMs) is the structural fix.
