# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-05-27

### Added

- **Human-readable docs site at `pond.run/docs`.** The five reference docs (`cli-reference`, `api-reference`, `client-reference`, `mcp`, `operations`) used to be served only as raw `text/markdown` — perfect for the agent flow (Claude/Cursor fetch them as plain text), useless if you opened one in a browser. `pond host` now serves them as rendered HTML too: `/docs` is a curated index, `/docs/<slug>` renders the markdown with sidebar navigation, anchored headings (so `/docs/cli-reference#pond-deploy` deep-links), styled code blocks, GFM tables, and brand-consistent dark styling that matches the 0.3.0 design language (black background, mono accents, no rounded corners, no rainbow syntax-highlighting). The existing `/docs/<slug>.md` route is unchanged — agents and `llms.txt` keep working exactly as before. Markdown parsing is via the `marked` library; rendering is server-side, no JS framework, no client-side hydration.
- The landing page "Docs" link now points to `/docs` instead of GitHub. A separate "GitHub" link is added next to it.

### Changed

- **`docs/cli-reference.md` brought up to date for 0.3.0.** The `pond deploy` and `pond fork` sections were last revised in 0.2.7 and described the old behavior — local-by-default `pond deploy`, no `--local`, no `--allow-scripts`, fork using a `--dir` flag that was actually named `--name`. Now reflects the actual CLI surface as of 0.3.0.

## [0.3.0] - 2026-05-27

### Changed

- **Templates ship raw Tailwind, not a built-in component system.** The dark-mode CSS variables (`--bg`/`--fg`/`--border`/...) and opt-in classes (`.btn`/`.card`/`.input`/`.label`/`.kbd`/`.divider`) added in 0.2.5 are gone from the bundler's HTML shell. Every capsule landed on the same `bg-zinc-950` + card-stack look — the "instant polish" became "instant AI-default." The bundler now ships a minimal safety net (`* { box-sizing: border-box }`) and lets each template own its visual identity. The capsule contract in AGENTS.md / `.claude/CLAUDE.md` / `.cursor/rules/pond.mdc` flips from "prefer these classes" to a list of AI-default patterns to actively avoid (`bg-zinc-950` card stacks, white-pill buttons, `text-2xl` page titles, universal `rounded-lg`) plus a "one signature move per capsule" rule. All five templates (`todo`, `chat`, `feed`, `crud`, `dashboard`) were rewritten to demonstrate the new aesthetic: display headings, mono accents on machine-flavored text (timestamps, indices, source tags), wireframe or brand-colored buttons, `divide-y` row lists instead of card-per-item. **This changes how every freshly-scaffolded capsule looks** — existing capsules are unaffected (the CSS only applied to the bundler-generated HTML shell, which is regenerated per-deploy).
- **`pond deploy` defaults to hosted (`https://pond.run`).** Previously, bare `pond deploy` wrote a local bundle to `.pond/deploy-bundle.mjs` and exited — which contradicted the package's own marketing ("Hosted Lakebed-style anonymous deploys included") and made the one-command first-run flow impossible. Now `pond deploy` with no args uploads an anonymous deploy to `https://pond.run` and prints the live URL + claim token + IDE URL. The CLI prints `→ No deploy target set; uploading to https://pond.run (anonymous). Pass --local to build offline instead.` before the upload so the behavior isn't invisible. **This is a behavior change**: if you previously relied on `pond deploy` producing a local bundle (CI, airgapped, self-hosted shipping), pass `--local` (see below). `pond deploy --api <url>` is unchanged for self-hosted control planes.
- **Smart redeploy.** When `.pond/deploy.json` already records an `apiUrl` from a prior hosted deploy, plain `pond deploy` redeploys to that same control plane instead of defaulting to `pond.run`. No more "where did this deploy go?" surprises after switching between hosted control planes.
- **Printed IDE / management URLs trust the CLI's known `apiUrl`, not the server's echoed `remote.apiUrl`.** Some control planes (incl. current `pond.run`) echo their internal bind address back in the response body (e.g. `http://0.0.0.0:8787`), which made every printed `IDE:` / `Manage env with:` line unusable. The CLI now uses the address it actually deployed to. Same fix on the `apiUrl` field saved to `.pond/deploy.json`.

### Added

- **`pond deploy --local`.** Explicit opt-in for the old offline-bundle behavior — builds `.pond/deploy-bundle.mjs` + `.pond/deploy.json` without uploading. Use for airgapped/self-host scenarios where you ship the bundle yourself with `pond start`.

### Security

- **`pond fork` no longer auto-runs upstream lifecycle scripts.** A hostile or compromised public capsule could ship a `package.json` whose `postinstall` script is arbitrary shell — and the CLI's "next step" message tells the user to run `npm install` three lines later. `pond fork` now refuses to write any `package.json` containing `preinstall`/`install`/`postinstall`/`prepare`/`postprepare` unless the user passes `--allow-scripts`. The refusal message names the offending scripts.
- **`pond fork` validates the control-plane URL it derives.** Previously, pasting any `<id>.evil.com` URL into `pond fork` would route the source download through `evil.com` (the CLI silently stripped the deploy subdomain and used the rest as the API base). Now: when the API base is *derived* from a pasted deploy URL, only `pond.run` and `*.pond.run` are accepted; anything else requires an explicit `--api` opt-in. Plain `http://` is refused for non-loopback hosts.
- **Dev server `/__pond/*` debug routes are gated by Origin + Host checks.** The dev server's debug surface (`/__pond/db/tables`, `/__pond/db/dump/:table`, `/__pond/inspect`, `/__pond/logs`, `/__pond/auth/guest`) was reachable from any browser tab on the machine — wide-open `cors()` made the responses readable cross-origin, and DNS rebinding could bypass the loopback bind. A new middleware on `/__pond/*` rejects requests whose `Origin` is set and cross-origin, or whose `Host` header isn't `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`. User-defined routes on the dev server are unchanged.

### Fixed

- **`pond claim` no longer drops `0o600` on `.pond/deploy.json`.** `pond deploy` writes the file at mode `0o600` (it contains the claim token); `pond claim` rewrote the same file with default umask, undoing the protection on every claim. Now matches `deploy.ts`.

## [0.2.11] - 2026-05-27

### Changed

- **README Quickstart leads with `npx pondsh new …`.** Following the 0.2.8 `pondsh` bin alias and the 0.2.10 hoisting fix, the canonical run-without-install command (`npx pondsh new my-capsule`) actually works on a clean machine — surface it as the primary path. Global install via `npm install -g pondsh` is still documented but moved below. The `--generate` example uses the npx form too and shows what the flag does (invokes the local agent headlessly) instead of just demoing the stub-scaffold path.

## [0.2.10] - 2026-05-27

### Fixed

- **Client bundler resolves `preact` regardless of npm hoisting.** `buildClient` in `src/bundler.ts` aliased `preact`, `preact/hooks`, and `preact/jsx-runtime` to `path.resolve(import.meta.dirname, "../node_modules/preact/...")` — that path only resolves when preact is nested under `pondsh/node_modules`, which modern npm doesn't do because it hoists peers up to the consumer's root `node_modules`. Every fresh `npm install pondsh` produced `ERROR: Could not resolve "...pondsh/node_modules/preact/dist/preact.module.js"` on first `pond dev`. Now uses `createRequire(import.meta.url).resolve("preact/package.json")` to find preact wherever Node's module resolution puts it (root, nested, pnpm symlinks, all fine).

## [0.2.9] - 2026-05-27

### Fixed

- **`boolean()` columns no longer crash mutations.** `buildDbProxy.insert` / `.update` forwarded JS `true` / `false` straight to better-sqlite3, which rejects boolean bindings with `SQLite3 can only bind numbers, strings, bigints, buffers, and null` — so every `--generate`d capsule with a `boolean()` column 500'd on the first mutation. The runtime now coerces booleans to `1` / `0` at the binding boundary. Backfilled `test/runtime-features.test.mjs` with an end-to-end roundtrip (the previous boolean test only created the column and never inserted into it, which is how the bug shipped).

## [0.2.8] - 2026-05-27

### Added

- **`pondsh` bin alias.** `npx pondsh@<v> pond new …` (without the `-p` flag) now works. Previously npx interpreted `pondsh` as the binary name, found no match (the bin was just `pond`), and failed with `could not determine executable to run`. Both `npx pondsh new …` and the older `npx -p pondsh pond new …` form route through the same CLI entry.

## [0.2.7] - 2026-05-27

### Changed

- **Hermes integration switched from HTTP probe to CLI spawn.** Previously `pond new --generate` probed `127.0.0.1:8642/v1/models` for an OpenAI-compatible endpoint and, on failure, tried to start one with `hermes-agent serve` — but `hermes-agent` is a chat REPL shim that silently ignores `serve` and runs a hard-coded demo query, so the start path always timed out after 15s. The real CLI is `hermes` with a `-z "<prompt>"` one-shot flag, mirroring `claude -p` and `codex exec`. `detectHermes` now does `which("hermes")`; `invokeHermes` spawns `hermes -z <prompt>` and streams stdout. No HTTP, no auth wiring, no gateway-start dance.
- Removed `detectHermesInstall`, `startHermesGateway`, and `promptYesNo` from `src/detect-agents.ts` (the prompt block in `pond new --generate` that asked "Start it now and use it for --generate?" is gone — the whole flow it gated never worked).
- Removed the `POND_HERMES_START_ARGS` env var — it overrode a verb on a binary that didn't accept any verb.

### Added

- **`docs/cli-reference.md`** — full CLI reference covering every `pond` subcommand (`new`, `dev`, `deploy`, `host`, `db`, `logs`, `inspect`, `fork`, `claim`, `login`, `user`, `token`, `domains`, `env`, `auth`) with when-to-use, key flags, and worked examples. Served at `https://pond.run/docs/cli-reference.md`, registered in `llms.txt`, and concatenated into `llms-full.txt`.

## [0.2.6] - 2026-05-27

### Fixed

- **`pond host` sandbox boot on Node 24.** Node 24 removed the `--experimental-permission` flag (renamed to `--permission` in Node 23, stable). `forkDeploy` was hard-coding the experimental form, so forked workers exited with `code=9 (bad option)` before booting and every sandboxed/anonymous deploy failed. Now selects `--permission` for Node 23+ and keeps `--experimental-permission` for Node 22 LTS. CI's Node 24 matrix lane is green again.

## [0.2.5] - 2026-05-27

### Fixed

- **Void mutations no longer crash the client.** `apiFetch` in `pond/client` was unconditionally calling `res.json()` on every response, which threw `SyntaxError: Unexpected end of JSON input` for mutations that return `void` (empty body). Now reads `text()` first and only parses when non-empty. Affected every generated app that called a void mutation (e.g. `addItem`, `deleteItem`).
- **`pond dev` falls back when the port is taken.** Previously, anything squatting on port 3000 caused `EADDRINUSE` and a hard crash. Now probes the requested port (default 3000) and walks forward up to 20 ports, logging `port 3000 in use — using 3001 instead` when it shifts.

### Changed

- **Built-in design system.** The HTML shell generated by `pond/bundler` now ships CSS variables (`--bg`, `--bg-elev`, `--fg`, `--fg-muted`, `--fg-subtle`, `--border`, `--accent`, `--danger`, `--success`, `--radius`, `--radius-sm`, `--radius-lg`) and opt-in component classes — `btn` (+ `-primary` / `-secondary` / `-ghost` / `-danger`), `card`, `input`, `textarea`, `select`, `label`, `kbd`, `divider` — for a consistent shadcn-dark baseline across `pond dev`, `pond deploy`, and `pond host`. The capsule contract in `AGENTS.md` / `.claude/CLAUDE.md` now teaches the agent to prefer these classes for instant polish and override with Tailwind utilities when needed.

## [0.2.4] - 2026-05-27

### Changed

- **`pond new "<prompt>" --generate` no longer scaffolds a template.** With `--generate`, the user's prompt drives 100% of the app instead of "todo template + agent overlay" — the scaffold writes a minimal blank-canvas stub (empty capsule, placeholder UI) and lets the agent design schema, queries, mutations, and UI from scratch. The CLI output reads `Created my-app/ (stub scaffold — agent will design from your prompt)` instead of the misleading `(template: todo)`. Pass `--template <name>` to opt back into the template path even with `--generate`.
- **Broadened the `todo` template's keyword set** (`tracker`, `habit`, `journal`, `expense`, `weight`, `mood`) so prompts like "habit tracker" or "expense log" lock onto todo via the heuristic without falling through to the silent default. This only matters when `--generate` is _not_ set, since `--generate` skips the heuristic entirely.

### Added

- **Interactive hermes-agent startup.** When `pond new --generate` runs on a TTY and finds the hermes-agent binary or config dir but the gateway is down, the CLI now asks `Start it now and use it for --generate? [Y/n]`. On `yes`, pond spawns `<binary> serve` (override via `POND_HERMES_START_ARGS`) detached with stdio piped to a log under `$TMPDIR`, polls `/v1/models` every 300 ms for up to 15 s, then prepends hermes to the cascade if the gateway comes up. Non-TTY runs are unchanged (deterministic, no prompt).
- `startHermesGateway()` and `promptYesNo()` exports in `src/detect-agents.ts` for the above.

### Fixed

- The previous `0.2.3` hint-only behavior is replaced by the interactive flow above. (0.2.3 was tagged but never published to npm, so this release supersedes it.)

## [0.2.3] - 2026-05-27

### Added

- **Hermes "installed but not running" hint.** `pond new` now looks for a `hermes-agent` binary on PATH or a `~/.hermes-agent` / `~/.config/hermes-agent` config dir even when the gateway isn't listening on 127.0.0.1:8642. If it finds one, the CLI prints a short hint suggesting the user start the gateway (e.g. `hermes-agent serve`) so hermes can lead the cascade instead of silently deferring to claude/codex.

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
