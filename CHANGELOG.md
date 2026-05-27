# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-05-27

### Fixed

- **`pond new --generate`** previously hung against Claude Code / Codex CLI because the headless `-p` / `exec` modes still gated Edit, Write, and Bash on an interactive approval that no one was watching. Now passes `--permission-mode bypassPermissions` (Claude) and `--full-auto` (Codex) so the headless invocation can actually write the files it was asked to write.

## [0.2.1] - 2026-05-27

### Fixed

- **`pond new --generate`**: when the first detected agent fails (e.g. hermes returns an unauthenticated response or the model is unloaded), the CLI now falls through to the next candidate in the cascade instead of bailing. The AGENTS.md still survives a total failure for retry.
- **Hermes detection**: a `401` from `127.0.0.1:8642/v1/models` no longer counts as "alive" — that indicates an unusable instance, so the cascade skips straight to `claude` / `codex`.

## [0.2.0] - 2026-05-27

A capability + ergonomics release. New capsule primitives (`ctx.ai`, `ctx.blob`, `socket()`, per-route `rateLimit`), additional auth providers, a template library, IDE polish, an MCP server, and a per-user `/dashboard`.

### Added

- **`ctx.ai`** — built-in LLM primitive. Routes to Anthropic / OpenAI / a local Hermes-compatible endpoint based on which key is set; `complete()` + `stream()`.
- **`ctx.blob`** — per-deploy key/value blob store. `put/get/delete/list` with metadata mirrored in `_pond_blobs`; readable at `/api/blob/:key`.
- **`socket()`** — WebSocket handlers on capsules. Mounted at `/api/socket/<name>`. Host control plane proxies the HTTP Upgrade through a raw TCP pipe; dev server has a hot-reload-aware upgrade handler.
- **Per-route rate limits** — `capsule({ rateLimit: { addItem: { perMinute: 60, by: "user" } } })`. Over-limit requests get `429 Rate limited` with `Retry-After`.
- **`/__pond/metrics`** — Prometheus text format. `pond_route_requests_total`, `pond_route_errors_total`, `pond_route_duration_ms` (p50/p95/p99 over a rolling 500-sample window).
- **Additive schema migrations** — new tables auto-created, new columns auto-added via `ALTER TABLE`. Destructive changes (column drops) raise a clear error instead of silently breaking the deploy.
- **GitHub OAuth** + **email magic links** — alongside the existing Google OAuth. Magic-link tokens land in `_pond_magic_links`; the runtime emits via Resend when `RESEND_API_KEY` + `EMAIL_FROM` are set, otherwise logs the link.
- **`pond new --generate`** — detects a locally running agent (hermes → claude CLI → codex CLI) and streams its output to scaffold the capsule from the prompt. Detection happens on every `pond new`; invocation is opt-in.
- **Template registry** — `pond new --list-templates` enumerates six templates: `todo`, `auth-app`, `blog`, `chat`, `dashboard`, `webhook-handler`. Without `--template`, prompt-based heuristic picks the closest match.
- **`pond fork <url-or-id>`** — pulls source from a public deploy and scaffolds a local copy ready for `pond dev`.
- **`/gallery`** at the bare host — lists capsules opted-in via `capsule({ public: true, title, description })`. Includes copy-as-`pond fork` button.
- **`/dashboard` SPA** — per-user view of deploys with rotate-claim, rotate-user-token, delete, and open-IDE actions. Token-gated; reuses existing control-plane endpoints.
- **`pond-mcp`** — Model Context Protocol server bin. Eight tools (`list_deploys`, `deploy_files`, `read_file`, `write_file`, `build_deploy`, `tail_logs`, `env_list`, `env_set`). `claude mcp add pond pond-mcp` and Claude Code can manage capsules natively. See `docs/mcp.md`.
- **IDE polish** — streaming logs pane (SSE, pause-on-hover, level filter), env editor (masked values, add/edit/delete, rebuild on save), command palette (Cmd/Ctrl-K), global file search (Cmd/Ctrl-Shift-F), pre-deploy side-by-side diff modal.
- **`pond db backup`** + **`pond db restore`** — local snapshots via `VACUUM INTO`; restore stages to `.pond/data.db.restored` for a post-stop swap.
- **`.cursor/rules`** + **`.claude/CLAUDE.md`** in every scaffold — agents opening a fresh capsule pick up the contract immediately.

### Changed

- CI matrix bumped: `actions/checkout@v5`, `actions/setup-node@v5`, Node 20/22/**24**.
- `_pond_users` schema gained a `githubId` column; lightweight migration runs on boot for older DBs.

### Dependencies

- Added `ws` (^8.21.0).

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
