# Pond deployment kit

Two supported paths, both budget-friendly:

| Path                            | Compute                   | Ingress                  | TLS                             | Cost        | When                        |
| ------------------------------- | ------------------------- | ------------------------ | ------------------------------- | ----------- | --------------------------- |
| **Docker + Cloudflare Tunnel**  | Any host that runs Docker | Cloudflare Tunnel (free) | Cloudflare Universal SSL (free) | Domain only | Fastest. Recommended.       |
| **Systemd + Cloudflare Tunnel** | Bare VM                   | Cloudflare Tunnel (free) | Cloudflare Universal SSL (free) | Domain only | When you don't want Docker. |

The full operational walkthrough lives in [`docs/operations.md`](../docs/operations.md). This directory has the files referenced there.

## Files

- `Dockerfile` — production image for the control plane. Multi-arch (works on Oracle ARM, x86 VPS, Apple Silicon).
- `docker-compose.yml` — runs `pond-host` + `cloudflared` on the same machine.
- `.env.example` — copy to `.env`, fill in your domain + host token + abuse contact.
- `cloudflared/config.example.yml` — Cloudflare Tunnel ingress config. Maps `*.pond.example.com` and the bare `pond.example.com` to the host on port 8787.
- `pond-host.service` — systemd unit for the no-Docker path.
- `upgrade.sh` — one-shot upgrade: `git pull --ff-only`, rebuild the pond-host image, restart in place. Run from the pond repo root on the host.

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
