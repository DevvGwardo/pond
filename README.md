# Pond

<p align="center">
  <img src="https://raw.githubusercontent.com/DevvGwardo/pond/main/docs/branding/pond-title.png" alt="Pond title image" width="100%" />
</p>

<p align="center">
  <strong>Agent-native full-stack TypeScript capsules.</strong><br />
  Scaffold a small app, define your schema and handlers in one file, and run it locally with a built-in Hono + SQLite runtime.
</p>

<p align="center">
  <img alt="Node 18+" src="https://img.shields.io/badge/node-%3E%3D18-16351f?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-first-0f172a?style=flat-square" />
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-hono%20%2B%20sqlite-10243f?style=flat-square" />
  <img alt="Client" src="https://img.shields.io/badge/client-preact-2a163c?style=flat-square" />
</p>

Pond is an open-source, agent-native CLI and runtime for building small full-stack TypeScript apps called capsules. It is designed around a tight inner loop:

1. `pond new` scaffolds a capsule.
2. You define schema, queries, mutations, and endpoints in `server/index.ts`.
3. `pond dev` compiles the capsule, provisions SQLite automatically, bundles the client, and serves the app.

The current runtime is optimized for local development and alpha workflows: fast scaffolding, zero-config SQLite, simple auth, live reload, and inspection endpoints that make capsules easy to reason about.

## Why Pond

- Single-file server model. Schema, queries, mutations, and endpoints live together in the capsule definition.
- Built-in local runtime. Pond compiles the server with esbuild, mounts routes on Hono, and auto-creates SQLite tables.
- No manual client plumbing. Preact hooks talk to generated query and mutation routes directly.
- Agent-friendly workflow. The CLI is small, inspectable, and easy for coding agents to scaffold against.
- Real dev ergonomics. Live reload, guest identity switching, DB inspection, logs, and a deploy bundle path are already built in.

## What A Capsule Looks Like

```ts
import { capsule, mutation, query, string, table } from "pond/server"

export default capsule({
  schema: {
    messages: table({
      body: string(),
    }),
  },

  queries: {
    messages: query((ctx) =>
      ctx.db.messages.orderBy("createdAt", "desc").all()
    ),
  },

  mutations: {
    sendMessage: mutation((ctx, body: string) =>
      ctx.db.messages.insert({ body })
    ),
  },
})
```

That one definition becomes:

- a SQLite-backed `messages` table
- `GET /api/query/messages`
- `POST /api/mutation/sendMessage`
- a typed server runtime context with `db`, `auth`, `env`, and `log`

## Quickstart

```bash
npm install
npm run build
node ./src/cli.js new my-capsule
cd my-capsule
node /path/to/pond/src/cli.js dev
```

If you install the package globally or publish it, the intended workflow is:

```bash
pond new my-capsule
cd my-capsule
npm install
pond dev
```

Open `http://localhost:3000`.

## Developer Loop

```bash
pond new chat-demo
cd chat-demo
npm install
pond dev
```

Pond will:

- scaffold `server/index.ts`, `client/index.tsx`, `shared/`, and `.env.pond.server`
- scaffold a capsule `package.json` with local `pond` scripts
- initialize a git repository by default
- compile the capsule server with esbuild
- create `.pond/data.db`
- create tables from the capsule schema
- bundle the Preact client and serve an HTML shell
- watch `server/index.ts`, `client/index.tsx`, and `.env.pond.server`
- push reload events over `/__pond_reload`

<p align="center">
  <img src="https://raw.githubusercontent.com/DevvGwardo/pond/main/docs/branding/pond-workflow.png" alt="Pond workflow image" width="100%" />
</p>

## CLI

| Command | Purpose |
| --- | --- |
| `pond new <name>` | Scaffold a new capsule |
| `pond dev --port 3000` | Run the local dev server |
| `pond deploy` | Build a standalone server bundle and write deploy metadata |
| `pond deploy --api http://localhost:8787` | Upload a hosted deploy to a Pond control plane |
| `pond claim` | Cross-machine claim using a deploy's claim token |
| `pond start` | Start the bundled deploy artifact locally |
| `pond host` | Start the self-hosted Pond control plane |
| `pond inspect` | Inspect local capsule metadata |
| `pond logs` | Stream structured local logs |
| `pond db list` | List SQLite tables from a running capsule |
| `pond db dump [table]` | Dump one table or the full local database |
| `pond auth as <name>` | Set the current dev guest identity |
| `pond login --api <url> --username <name>` | Bootstrap first admin (needs `POND_HOST_TOKEN`) or attach with `--token` |
| `pond user create <name> [--admin]` | Create a new control-plane user (admin only) |
| `pond env list/set/unset <deployId>` | Manage hosted-deploy server env vars |
| `pond token rotate --api <url>` | Rotate the saved user API token |

## Runtime Model

<p align="center">
  <img src="https://raw.githubusercontent.com/DevvGwardo/pond/main/docs/branding/pond-how-it-works.png" alt="How Pond works diagram" width="100%" />
</p>

At runtime, Pond does four things:

1. Bundles `server/index.ts` into a temporary ESM module.
2. Imports the capsule definition and creates SQLite tables from `schema`.
3. Resolves auth per request from the session cookie, falling back to a guest user when no session exists.
4. Mounts generated routes and any custom endpoints onto a Hono server.

The client runtime exposes:

- `useQuery<T>(name)`
- `useMutation<TArgs, TResult>(name)`
- `useAuth()`
- `SignInWithGoogle`
- `signOut()`

## Authentication

Pond supports guest mode and Google OAuth in the local runtime.

Built-in auth routes:

- `GET /auth/google`
- `GET /auth/google/callback`
- `GET /auth/me`
- `POST /auth/signout`

Users are persisted to `_pond_users`. If no session cookie is present, the request is treated as a guest request and still has access to the capsule unless your own handlers restrict it.

Environment variables live in `.env.pond.server`:

```bash
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
```

If `GOOGLE_REDIRECT_URI` is omitted, Pond defaults it to the current dev port.

## Inspection And Debugging

When running locally, Pond exposes internal inspection endpoints:

- `GET /__pond/db/tables`
- `GET /__pond/db/dump/:table`
- `GET /__pond/logs`
- `GET /__pond/inspect`
- `POST /__pond/auth/guest`

These power the CLI inspection commands and make local capsules easy to inspect without wiring separate admin tooling.

## Deploy Bundles

`pond deploy` currently performs an alpha deployment step:

- bundles the capsule server to `.pond/deploy-bundle.mjs`
- writes `.pond/deploy.json`
- generates a deploy ID, timestamp, and bundle hash

This is a build artifact flow, not a full hosted deployment platform yet. The runtime already emits metadata in a shape that can later back integrations with services like Fly.io or Railway.

## Hosted control plane (self-hosted MVP)

Pond ships a self-hostable control plane that fronts multiple capsule deploys behind a single ingress, manages user accounts and per-deploy ownership, and isolates each deploy in its own forked worker process.

### Threat model

The hosted control plane is intended for **trusted deployers** (you and your team). Isolation between deploys is V8-level (one Node child process per deploy) — not OS-level. Sibling deploys run under the same UID and can read each other's files. Do **not** host untrusted third-party code on a single pond host yet.

### Bootstrap quickstart

```bash
# 1. Start the control plane (binds 127.0.0.1:8787 by default)
pond host --port 8787

# 2. Note the bootstrap token printed in the log, then create the first admin
POND_HOST_TOKEN=<that-token> pond login --api http://localhost:8787 --username admin

# 3. Deploy a capsule from any project directory
pond deploy --api http://localhost:8787
```

### Multi-user

```bash
# As admin, mint a token for bob
pond user create bob --api http://localhost:8787

# On bob's machine, attach to that account
pond login --api http://localhost:8787 --token <bob-token> --username bob
```

Each deploy is owned by the user that created it. Admins can manage any deploy. The legacy claim token in `.pond/deploy.json` still works for cross-machine ownership transfer via `pond claim`.

### Env management

```bash
pond env list <deployId> --api http://localhost:8787
pond env set <deployId> KEY=value --api http://localhost:8787
pond env unset <deployId> KEY --api http://localhost:8787
```

Updating env triggers a worker re-fork so the new values take effect immediately.

### Token rotation

```bash
# User-side: rotate your own API token
pond token rotate --api http://localhost:8787

# Per-deploy: rotate the claim token (owner or admin)
curl -X POST -H "Authorization: Bearer <token>" \
  http://localhost:8787/api/deploys/<deployId>/rotate-claim-token
```

### Quotas

Every deploy has a quota, enforced by the control plane:

| Field | Default | Enforcement |
| --- | --- | --- |
| `maxBundleBytes` | 64 MB | POST/PUT bundles larger than this return 413 |
| `maxDiskBytes` | 512 MB | post-write directory size check on bundle and env updates |
| `maxMemoryMb` | 256 | passed to the worker via `--max-old-space-size` |

Admins can override per deploy:

```bash
curl -X PUT -H "Authorization: Bearer <admin-token>" \
  -H "content-type: application/json" \
  -d '{"maxMemoryMb": 512}' \
  http://localhost:8787/api/deploys/<deployId>/quota
```

Changing `maxMemoryMb` triggers a worker re-fork. There is no CLI subcommand for quotas yet — use `curl`.

### Ingress & CORS

The control plane routes requests by subdomain (`<deployId>.<publicHost>:<port>`) to the matching forked worker. Same-origin CORS is enforced at both the control plane and the deploy worker: cross-origin browser requests receive **no** `Access-Control-Allow-Origin` header by default. A capsule can opt extra origins in by exporting `allowedOrigins: string[]` from `capsule({ ... })`.

### Persistent logs

Each deploy's `ctx.log.*` entries stream over SSE on `/__pond/logs` and are appended as NDJSON to `<deploy-dir>/.pond/logs.ndjson`. The file rotates at 5 MB (one prior generation kept as `logs.ndjson.1`). On restart, the most recent 200 entries are restored.

### What is NOT solved yet

- No OS-level isolation between deploys (no containers, no seccomp).
- No HTTPS, no automatic TLS, no custom domains, no wildcard DNS.
- No billing, no usage metering beyond hard quota limits.
- No WebSocket support through the proxy.
- No UI — everything is CLI + HTTP.

## Public Server API

Pond currently exports these server-side primitives from `pond/server`:

- `capsule()`
- `table()`
- `string()`
- `number()`
- `boolean()`
- `query()`
- `mutation()`
- `endpoint()`
- `json()`
- `text()`

The request context exposes:

- `ctx.db`
- `ctx.auth`
- `ctx.env`
- `ctx.log`

## Project Status

Pond is in alpha. The current codebase is strongest at:

- local development
- small SQLite-backed apps
- generated query and mutation routes
- simple auth flows
- agent-friendly scaffolding

Still early:

- deployment is bundle-first, not platform-native
- there is no first-class hosted control plane yet
- the default template is intentionally small

## Repository Layout

```text
src/
  cli.ts
  commands/
  runtime.ts
  dev-server.ts
  bundler.ts
  server/
client/
  index.ts
bin/
  pond.js
docs/
  branding/
```

## Branding

The current visual direction is intentionally simple:

- dark water palette
- bright signal greens for active runtime energy
- capsule and ripple geometry instead of generic SaaS gradients
- diagrams that explain the mental model instead of decorative filler

Brand assets live in [`docs/branding`](./docs/branding).

## License

The package is currently marked `UNLICENSED` in [`package.json`](./package.json). If this is meant to be open source in the usual sense, the next step is to choose and add an explicit license file.
