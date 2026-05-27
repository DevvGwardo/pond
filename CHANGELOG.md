# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-26

First public release. Tagged after a security-hardening pass on the alpha.

### Added

- **Hosted control plane** (`pond host`): anonymous + authenticated deploys, custom subdomains, claim tokens, per-deploy quotas, Node 22 `--experimental-permission` sandbox for anonymous workers.
- **`--public-base-url`** flag — control plane returns external URLs (`https://abc.pond.example.com`) instead of `http://localhost:port`.
- **`--abuse-email`** flag — populates abuse policy + security.txt contact.
- **Landing / abuse / security.txt routes** at the bare external domain.
- **Audit log** (`GET /api/audit`, admin-only) tracking every mutation: user.create, user.rotate_token, deploy.{create, update, delete, claim, rotate_claim_token, quota_update, env_update, env_delete}, domain.{add, remove}.
- **Persistent per-IP anonymous rate limit** — survives host restart (was in-memory).
- **Token rotation grace window** — previous token authenticates for 5 minutes after rotate, so in-flight clients can swap.
- **env caps** — 64 KB total, 256 entries, 1024 chars per value (was unbounded).
- **`pond/client` SDK** (`useQuery`, `useMutation`, `useAuth`, `SignInWithGoogle`, `signOut`) — was a stub.
- **Reserved-identifier denylist** — SQLite keywords, `_pond_` prefix, 64-char cap on schema names.
- **Deployment kit** in `deploy/` — Dockerfile, docker-compose, systemd unit, cloudflared config template.
- **Operations guide** at `docs/operations.md` — full Lakebed-style launch runbook.
- **API references** at `docs/api-reference.md` (server) and `docs/client-reference.md` (client).
- **CLI integration tests** (`test/cli.test.mjs`) covering `new`, `dev`, `deploy`, `start`.

### Changed

- `pond dev` binds to `127.0.0.1` only (was all interfaces). `/__pond/auth/guest` validates input.
- `.pond/deploy.json` written with mode 0600 (was world-readable; contains claim token).
- `pond deploy --api http://<non-loopback>` prints a stderr warning about plaintext credentials.
- Dev-server file watcher is trailing-edge debounced (200 ms).
- `pond new`: the boolean flag is now `git` (default true). Pass `--no-git` to skip (citty's natural negation).
- Repository is prettier-formatted; CI gates on `npm run format:check`.

### Fixed

- B1: malformed JSON on POST/PUT `/api/deploys` returns 400 instead of 500.
- B2: anonymous workers cannot use `node:http` / `node:https` / `tls.connect` (net.Socket shim).
- B4: PUT `/api/deploys/:id/quota` with empty body returns 400 instead of silent 200.
- B5: per-user custom-domain quota (50) prevents domain-table DoS.
- B6: 16-char hex deploy ID routing rule no longer overlaps with 8-char custom subdomains.
- Anonymous deploy boot failure rolls back disk + DB rows (no leaked deploy dirs).

### Known limitations

- JS-level network shim is not airtight (no DNS-layer block, no protection against native modules). Combine with OS egress firewall for hostile-tenant hosting.
- Single-instance control plane (SQLite, no horizontal scaling).
- No payments / paid tier.
- `dns.lookup` from anonymous workers is not blocked; DNS exfiltration remains possible at the JS layer (commit 6297160 documents the rationale).
