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
