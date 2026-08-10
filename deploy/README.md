# Pond deployment kit

Three supported paths:

| Path                            | Compute                   | Ingress                  | TLS                             | Cost          | When                                                 |
| ------------------------------- | ------------------------- | ------------------------ | ------------------------------- | ------------- | ---------------------------------------------------- |
| **Railway (managed PaaS)**      | Railway container         | Railway custom domain    | Railway-managed (incl wildcard) | Plan + domain | No host to run. Trade-off: OS hardening unavailable. |
| **Docker + Cloudflare Tunnel**  | Any host that runs Docker | Cloudflare Tunnel (free) | Cloudflare Universal SSL (free) | Domain only   | Full OS hardening (cgroups/nft/bwrap) available.     |
| **Systemd + Cloudflare Tunnel** | Bare VM                   | Cloudflare Tunnel (free) | Cloudflare Universal SSL (free) | Domain only   | When you don't want Docker.                          |

> **Railway caveat — OS hardening is off.** Railway grants no host privileges, so
> per-capsule cgroups, the nftables egress firewall, and `bwrap` filesystem
> isolation **cannot run** there. Anonymous capsules fall back to the Node
> `--permission` sandbox plus the userspace resource caps (concurrency ceiling +
> daily quotas). See [`HARDENING.md` §1b](HARDENING.md) for the full trust posture
> and the Phase 2 (isolate runtime) plan. The Docker/systemd paths are the ones
> where the kernel-enforced boundaries can be turned on.

The full operational walkthrough lives in [`docs/operations.md`](../docs/operations.md). This directory has the files referenced there.

## Files

- `Dockerfile` — production image for the control plane. Multi-arch (works on Oracle ARM, x86 VPS, Apple Silicon). Multi-stage: compiles TS from source so the image doesn't need committed `.js`. Used by both the Docker path and Railway.
- `pond-entrypoint.sh` — root entrypoint that chowns the (root-owned) volume mount, then drops to the unprivileged `node` user via `gosu`. Fixes Railway Volume / compose named-volume perms automatically.
- `../railway.json` (repo root) — Railway build (`deploy/Dockerfile`) + `/api/health` healthcheck config for the Railway path.
- `docker-compose.yml` — runs `pond-host` + `cloudflared` on the same machine.
- `.env.example` — copy to `.env`, fill in your domain + host token + abuse contact.
- `cloudflared/config.example.yml` — Cloudflare Tunnel ingress config. Maps `*.pond.example.com` and the bare `pond.example.com` to the host on port 8787.
- `pond-host.service` — systemd unit for the no-Docker path.
- `upgrade.sh` — one-shot upgrade: `git pull --ff-only`, rebuild the pond-host image, restart in place. Run from the pond repo root on the host.

## Quickstart (Railway path)

> **⚠ Status (2026-05-31): `pond.run` is served by the Docker + Cloudflare-Tunnel
> path (see below), NOT Railway.** A Railway `pond-host` service exists but DNS is
> **not** cut over to it and its volume holds **no production data** (deploys,
> users, and tokens live on the Tunnel host). Running `railway up` deploys to that
> idle service and does **not** affect live `pond.run`. Do not point `pond.run` DNS
> at Railway, and do not set `POND_PUBLIC_HOST=pond.run` on the Railway service,
> until you actually intend to migrate — see the cutover note at the end of this
> section.

Railway builds the image from source (`railway.json` → `deploy/Dockerfile`, a
multi-stage build that compiles the TS so the image doesn't depend on
gitignored `.js`). The host reads `PORT` and the `POND_*` vars from the Railway
environment — no shell-expanded start command needed.

```bash
# 1. Link the repo to a Railway service (once), then deploy.
railway up

# 2. Set config as Railway environment variables (Railway dashboard or CLI):
#    POND_PUBLIC_HOST, POND_PUBLIC_BASE_URL, POND_ABUSE_EMAIL,
#    POND_HOST_TOKEN, POND_TRUST_PROXY_HEADERS=1, POND_MAX_ACTIVE_CAPSULES, …

# 3. Workspace spend backstop (billing, not env). Limits are workspace-wide —
#    they cover every project in the Railway workspace, not pond alone.
#    Soft = email warning; hard = Railway pauses services when the cap is hit.
railway usage limit set --target workspace --soft 12 --hard 20
railway usage limit status   # verify Soft/Hard populated
# Dashboard equivalent: https://railway.com/account/usage
```

**Per-deploy serving needs a wildcard domain.** A created capsule's URL is
`<id>.<your-domain>`, so the host must sit behind a domain whose **wildcard
resolves**. Railway's generated `*.up.railway.app` does **not** resolve as a
wildcard, so the control plane works but individual deploys are unreachable on
the generated URL. Attach a custom domain + wildcard and point DNS at Railway:

```bash
railway domain pond.run       # bare domain (landing / control plane)
railway domain '*.pond.run'   # wildcard (per-deploy subdomains)
```

Each command prints the CNAME target to add at your DNS provider. For
`pond.run` (already attached to the `pond-host` service), the records are:

| Record (zone `pond.run`)   | Type  | Value                               | Purpose                         |
| -------------------------- | ----- | ----------------------------------- | ------------------------------- |
| `pond.run` (root)          | CNAME | `wy20ddwo.up.railway.app`           | bare-domain traffic             |
| `*.pond.run`               | CNAME | `3rolp8r7.up.railway.app`           | per-deploy subdomain traffic    |
| `_acme-challenge.pond.run` | CNAME | `3rolp8r7.authorize.railwaydns.net` | wildcard TLS cert (ACME DNS-01) |

On **Cloudflare** (this zone's provider), set all three records to **DNS only
(grey cloud)** — proxying them breaks Railway's ownership validation and TLS
issuance. Wildcard TLS is issued only after the `_acme-challenge` record
resolves.

Then flip the public host to the custom domain **after DNS is live** (doing it
before the records resolve breaks bare-domain/landing requests, since the host
treats requests whose host ≠ `POND_PUBLIC_HOST` as subdomain proxies):

```bash
railway variables --set POND_PUBLIC_HOST=pond.run \
  --set POND_PUBLIC_BASE_URL=https://pond.run
```

> Migrating from the Cloudflare-Tunnel path? `pond.run` currently points at the
> tunnel; updating these DNS records is the production cutover to Railway. The
> Tunnel-fronted Docker host can stay up until DNS propagates, then be retired.

## Quickstart (Docker path)

```bash
# 1. Configure
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env  # set POND_PUBLIC_HOST, POND_PUBLIC_BASE_URL, POND_ABUSE_EMAIL, POND_HOST_TOKEN

# 2. Provision the tunnel (one-time, on any machine with cloudflared installed)
cloudflared tunnel login
cloudflared tunnel create pond-host
cloudflared tunnel route dns pond-host pond.example.com
cloudflared tunnel route dns pond-host '*.pond.example.com'

# 3. Copy the credentials file into deploy/cloudflared/
cp ~/.cloudflared/<tunnel-id>.json deploy/cloudflared/credentials.json
cp deploy/cloudflared/config.example.yml deploy/cloudflared/config.yml
$EDITOR deploy/cloudflared/config.yml  # replace <TUNNEL_ID> and hostnames

# 4. Launch
docker compose -f deploy/docker-compose.yml up -d

# 5. Bootstrap your admin user
pond login --api https://pond.example.com --username your-name
# (Asks for the host token from your .env on first run.)
```

The full step-by-step (Oracle Cloud, DNS, security review, backups, upgrades, migration to Hetzner) is in [`docs/operations.md`](../docs/operations.md).

## Per-capsule isolation (cgroups + egress)

Capsules run as forked child processes of the control plane. By default each is
bounded only by a V8 heap cap (`--max-old-space-size`), so a capsule in a hot
loop, a memory balloon, or a fork bomb degrades every other deploy on the box,
and the in-process network block is leaky (DNS lookups and native addons escape
it — see the comments in `src/host/deploy-worker.ts`).

Two extra layers close those gaps. Both are opt-in and the host runs fine
without them; it prints which state it's in at startup
(`capsule isolation: cgroup v2 enabled …` vs `… OFF`).

1. **Container caps (always on).** `docker-compose.yml` bounds the whole
   `pond-host` container (`mem_limit`, `cpus`, `pids_limit`). Tune these to your
   host — they cap the blast radius even before per-capsule limits exist.

2. **Per-capsule cgroups + egress firewall (run the setup script).** Each
   capsule gets its own cgroup v2 (`cpu.max` / `memory.max` / `pids.max`, from
   its `DeployQuota`), and outbound traffic from capsule cgroups is default-deny
   via nftables (no DNS, no new connections — only loopback and replies on
   established flows).

### Enable it (Docker path — what pond.run uses)

```bash
# 1. Create the delegated cgroup root + load the egress rules (run on the host).
sudo POND_CAPSULE_CGROUP_ROOT=/sys/fs/cgroup/pond \
  ./deploy/setup-capsule-isolation.sh

# 2. Give the container a writable cgroup mount: uncomment in docker-compose.yml
#      - /sys/fs/cgroup:/sys/fs/cgroup:rw

# 3. Point pond-host at the cgroup root: uncomment in deploy/.env
#    POND_CAPSULE_CGROUP_ROOT=/sys/fs/cgroup/pond

# 4. Recreate the stack.
docker compose -f deploy/docker-compose.yml up -d --force-recreate pond-host
docker logs --tail 5 deploy-pond-host-1   # expect "capsule isolation: cgroup v2 enabled"
```

The container runs as root, so it can create per-capsule cgroups and migrate
worker pids freely. For the systemd / bare-VM path, see the commented
`Delegate=` block in `pond-host.service` (it needs `ProtectControlGroups=false`
and the service's own delegated cgroup as the root).

Per-deploy limits live in the `deploy_quotas` table (`maxCpuPercent`,
`maxMemoryMb`); admins can adjust them via `PATCH /api/deploys/:id/quota`.
Defaults: anonymous 25% CPU / 128 MB, owned 50% CPU / 256 MB.

## Upgrading

After pushing new commits to `main`, ssh to the host and run:

```bash
cd /path/to/pond
./deploy/upgrade.sh
```

The script does `git pull --ff-only` then `docker compose ... up -d --build` and tails the new container's logs. Pass `--skip-pull` to rebuild against an already-checked-out commit.

Before doing anything destructive, `upgrade.sh` fails fast if any of these required local files are missing:

- `deploy/.env`
- `deploy/cloudflared/config.yml`
- `deploy/cloudflared/credentials.json`

All three are gitignored (they contain secrets) and must exist before `docker compose up` will produce a working stack. See "Tunnel config recovery" below if they're missing.

## Tunnel config recovery

If `deploy/cloudflared/config.yml` or `credentials.json` is missing on the host (e.g. the host was rebuilt, the repo was re-cloned, or someone cleaned the dir), the `cloudflared` container will crash-loop with `open /etc/cloudflared/config.yml: no such file or directory` and pond.run will return Cloudflare error 1033 ("Argo Tunnel Connection Error"). To restore:

1. **Find the tunnel credentials.** They were originally created by `cloudflared tunnel create pond-host` on whichever machine you ran the login from. That command wrote `~/.cloudflared/<tunnel-id>.json`. If you still have that machine, copy the file off it. If not, you'll need to rotate: `cloudflared tunnel rotate <tunnel-id>` on a machine with `cloudflared tunnel login` already done.

2. **Place the credentials on the host.**

   ```bash
   scp ~/.cloudflared/<tunnel-id>.json root@<host>:/path/to/pond/deploy/cloudflared/credentials.json
   ssh root@<host> chmod 644 /path/to/pond/deploy/cloudflared/credentials.json
   ```

   `cloudflared` inside the container runs as a non-root user, so the file needs world-read permission. The mount is read-only on the container side, so this is safe.

3. **Recreate `config.yml`** from `config.example.yml`, substituting your tunnel ID and hostnames:

   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /etc/cloudflared/credentials.json

   ingress:
     - hostname: "*.pond.example.com"
       service: http://pond-host:8787
     - hostname: pond.example.com
       service: http://pond-host:8787
     - service: http_status:404
   ```

4. **Force-recreate the cloudflared container** so the bind mount picks up the new files:
   ```bash
   cd deploy && docker compose up -d --force-recreate cloudflared
   docker logs --tail 20 deploy-cloudflared-1   # expect "Registered tunnel connection"
   ```

A successful recovery shows multiple `Registered tunnel connection ... protocol=quic` lines in cloudflared's logs within ~10 seconds, and `https://<your-domain>/` returns 200 instead of 530.
