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
- Runtime disk watchdog stops a capsule that exceeds its disk quota; the
  `/__pond/db/restore` upload is bounded by the deploy's disk quota.
- Per-IP anonymous rate limiting prefers `CF-Connecting-IP` (unspoofable behind
  Cloudflare) over the client-settable `X-Forwarded-For`.

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

## 6. Known residual gaps

- **DNS / native-addon exfil** is closed only at the OS layer (nft drops 53 and
  all non-proxy egress). The JS sandbox is defense-in-depth, not the boundary.
- **Capsule-to-capsule on loopback** is closed for _new_ connections by the nft
  rule, but capsules still share a network namespace. Per-tenant netns (or
  microVMs) is the structural fix.
