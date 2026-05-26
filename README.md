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
| `pond claim` | Claim a hosted deploy and sync `.env.pond.server` |
| `pond start` | Start the bundled deploy artifact locally |
| `pond host` | Start the self-hosted Pond control plane |
| `pond inspect` | Inspect local capsule metadata |
| `pond logs` | Stream structured local logs |
| `pond db list` | List SQLite tables from a running capsule |
| `pond db dump [table]` | Dump one table or the full local database |
| `pond auth as <name>` | Set the current dev guest identity |

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

## Hosted MVP

Pond now includes a self-hostable control-plane MVP for hosted deploys and claim-based ownership.

Start the control plane:

```bash
pond host --port 8787
```

Create an anonymous hosted deploy:

```bash
pond deploy --api http://localhost:8787
```

That returns a hosted app URL and stores claim metadata in `.pond/deploy.json`.

Claim the deploy and sync server env:

```bash
pond claim
```

Hosted behavior in the current MVP:

- each deploy gets its own hosted app port
- inspect, DB dump, and logs are private by default
- the local claim token in `.pond/deploy.json` is sent automatically by hosted `pond inspect`, `pond db`, and `pond logs` commands when you target that deploy
- `.env.pond.server` is synced on claim and on later claimed redeploys

Examples:

```bash
pond inspect <deploy-id>
pond db dump messages --target <deploy-id>
pond logs --target <deploy-id>
```

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
