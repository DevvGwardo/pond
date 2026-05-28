# Capsule Spec

```
capsule-spec: 1
```

**Capsule Spec v1.** This is the authoritative, versioned definition of the Pond
capsule application format and its wire protocol. A program **conforms to Capsule
Spec v1** if (a) its source tree matches the directory contract and hard
constraints below, and (b) it only depends on the server API, client API, and
HTTP wire protocol defined here. Any runtime that mounts the routes in
[§5 Wire Protocol](#5-wire-protocol) with the request/response shapes given is a
**conformant runtime**: a Spec v1 capsule will run on it unchanged.

This spec is derived directly from the runtime source (`src/server/index.ts`,
`client/index.ts`, `src/runtime.ts`). Where prior prose docs disagreed with the
code, the code wins; the disagreements are listed in
[§8 Conformance notes & known doc drift](#8-conformance-notes--known-doc-drift).

Keywords **MUST**, **MUST NOT**, **SHOULD**, **MAY** are used in the RFC 2119 sense.

---

## 1. Directory contract

A capsule is a directory with this layout:

```text
<capsule>/
  server/index.ts      # REQUIRED — exports default capsule({...})
  client/index.tsx     # REQUIRED — exports a Preact component named App
  shared/              # OPTIONAL — pure TypeScript shared by both sides
  package.json         # REQUIRED — must not declare npm lifecycle scripts (see §1.4)
  .env.pond.server     # OPTIONAL — KEY=VALUE secrets, never bundled to the client
```

### 1.1 `server/index.ts`

- **MUST** end with a default export of `capsule({...})`:
  `export default capsule({ schema, queries, mutations, ... })`.
- **MUST** import its primitives only from `pond/server`.
- **MAY** import plain relative TypeScript (e.g. `../shared/...`) and Node
  built-ins that ship with the runtime.
- **MUST NOT** import arbitrary npm packages. The server file is bundled with
  esbuild using `packages: "external"` against an alias that resolves
  `pond/server` to the runtime; nothing else is provided.

### 1.2 `client/index.tsx`

- **MUST** export a Preact component named `App`. The runtime's HTML shell mounts
  `<App />` automatically; manual `render()` is not required.
- **MUST** import its hooks/components only from `pond/client`.
- **MAY** import plain relative TypeScript (e.g. `../shared/...`).
- **MUST NOT** import React, react-router, react-query, or any other npm UI
  library. Preact is the renderer; Tailwind utility classes are available without
  configuration (the runtime injects Tailwind).

### 1.3 `shared/` purity

- Files under `shared/` **MUST** be pure TypeScript importable by both server and
  client.
- They **MUST NOT** read env or secrets, touch DOM APIs, touch Node APIs, or call
  any pond runtime API (`pond/server` / `pond/client`). Keep them to types and
  pure functions.

### 1.4 `package.json`

- **MUST** exist. **MUST NOT** be deleted.
- **MUST NOT** declare npm lifecycle scripts (`preinstall`, `install`,
  `postinstall`, `prepare`, `postprepare`). Conformant control planes reject
  uploads containing them, and `pond fork` refuses to fork them without
  `--allow-scripts`. They are an RCE vector.

### 1.5 Authorization is the handler's job

The runtime resolves an identity into `ctx.auth` (see §3.4) but does **not**
enforce any access control on queries, mutations, or endpoints. Every handler is
responsible for its own authorization:

- Filter reads by `ctx.auth.userId`.
- Re-check ownership on every `update` / `delete`.
- Treat `ctx.auth.isGuest === true` as "no signed-in user".

There is no per-row ACL and no automatic owner column. If you do not check, the
data is effectively public to anyone who can reach the route.

---

## 2. Required imports

```ts
// server/index.ts
import { capsule, query, mutation, endpoint, socket, table, string, number, boolean, json, text } from "pond/server"

// client/index.tsx
import { useQuery, useMutation, useAuth, SignInWithGoogle, signOut, render, h } from "pond/client"
```

A capsule **MUST NOT** import any symbol from `pond/server` or `pond/client` that
is not listed in §3 / §4.

---

## 3. Server API contract (`pond/server`)

All signatures below are taken verbatim from `src/server/index.ts`.

### 3.1 Column types

```ts
interface ColumnType { _sqlType: string }

string():  ColumnType   // SQL TEXT
number():  ColumnType   // SQL REAL  (integers and floats both round-trip)
boolean(): ColumnType   // SQL INTEGER (JS true/false coerced to 1/0 on write,
                        //              read back as numeric 1/0)
```

`ColumnType` is opaque — the only field is `_sqlType`, used by the runtime to
emit `CREATE TABLE`. Capsules **MUST NOT** construct `ColumnType` by hand; use the
three helpers.

### 3.2 `table`

```ts
table<T extends Record<string, ColumnType>>(columns: T): T
```

Identity marker function. The object passed in is the table's user-defined
columns. The runtime adds three columns to **every** table automatically:

| Column      | SQL                                                             |
| ----------- | --------------------------------------------------------------- |
| `id`        | `TEXT PRIMARY KEY` (UUID, set on insert)                        |
| `createdAt` | `TEXT DEFAULT (datetime('now'))`                                |
| `updatedAt` | `TEXT DEFAULT (datetime('now'))` (re-stamped on every `update`) |

**Identifier rules** (enforced at migration time and on every dynamic column
reference in `ctx.db`). A table or column name **MUST**:

- match `/^[A-Za-z_][A-Za-z0-9_]*$/`,
- be at most 64 characters,
- not start with the reserved `_pond_` prefix,
- not be a SQLite reserved word (e.g. `order`, `group`, `where`, `select`, …).

Violations throw `Invalid identifier`, `Identifier too long`, the `_pond_`
reserved-prefix error, or `Identifier "X" is a SQLite reserved word`.

### 3.3 `capsule`

```ts
capsule(def: {
  schema:        Record<string, Record<string, ColumnType>>   // REQUIRED
  queries:       Record<string, QueryHandler>                  // REQUIRED
  mutations:     Record<string, MutationHandler>               // REQUIRED
  endpoints?:    Record<string, EndpointDefinition | EndpointHandler>
  sockets?:      Record<string, SocketDefinition>
  allowedOrigins?: string[]
  rateLimit?:    Record<string, RouteRateLimit>
  public?:       boolean
  title?:        string
  description?:  string
}): CapsuleDefinition
```

- `schema` keys are table names; each value is the column map from `table(...)`.
- `queries` / `mutations` map a route name to a handler (see §3.5).
- `endpoints` map a name to either an `endpoint(...)` definition (preferred) or a
  bare handler function. A bare function has no method/path and defaults to
  `GET /api/<name>` (see §5.4).
- `sockets` map a name to a `socket(...)` handler. Sockets are part of the format
  but are **not** carried over the hosted control-plane proxy in v1 (the local
  dev/`pond start` runtime mounts them; see §8).
- `rateLimit` keys match query / mutation / endpoint **names** (see §3.7).
- `public`, `title`, `description` feed the public listing / fork surface.

`schema`, `queries`, and `mutations` are required object literals. Empty objects
are allowed (`queries: {}`).

### 3.4 Context (`ctx`)

Every query, mutation, endpoint, and socket handler receives the same context as
its first argument:

```ts
interface CapsuleContext {
  auth: CapsuleAuth
  db: CapsuleDb
  env: Record<string, string>
  log: CapsuleLog
  ai: CapsuleAi
  blob: CapsuleBlob
}
```

> Note: older prose docs listed only `auth/db/env/log`. The actual context object
> built by the runtime (`buildContext`) always includes `ai` and `blob` too.

#### 3.4.1 `ctx.auth` — `CapsuleAuth`

```ts
interface CapsuleAuth {
  isGuest: boolean
  userId: string // "guest" for unauthenticated callers
  displayName?: string
  picture?: string
  email?: string
}
```

Resolved per request from the `pond_session` JWT cookie. No cookie / invalid /
expired ⇒ guest (`{ isGuest: true, userId: "guest", displayName: "Guest" }`).
Provider user-id shapes: Google ⇒ `<google-sub>`, GitHub ⇒ `github:<id>`,
email magic link ⇒ `email:<addr>`.

#### 3.4.2 `ctx.db` — `CapsuleDb`

A proxy with one property per schema table. Each table exposes:

```ts
interface CapsuleDbTable {
  where(column: string, value: any): QueryBuilder // chainable; multiple ANDed
  orderBy(column: string, dir: "asc" | "desc"): QueryBuilder
  limit(n: number): QueryBuilder
  all(): any[] // runs SELECT *
  get(id: string): any // SELECT by id; row or undefined
  insert(data: Record<string, any>): any // generates UUID id; returns row
  update(id: string, data: Record<string, any>): any // re-stamps updatedAt; returns row
  delete(id: string): void
}

interface QueryBuilder {
  orderBy(column: string, dir: "asc" | "desc"): QueryBuilder
  limit(n: number): QueryBuilder
  all(): any[]
}
```

Semantics derived from the runtime's `buildDbProxy`:

- `where`/`orderBy`/`limit` are immutable builders; chaining returns a new
  builder. Nothing executes until `.all()`, `.get()`, `.insert()`, etc.
- `where(col, val)` adds `col = ?`; multiple `where` calls are joined with `AND`.
- `orderBy` `dir` **MUST** be `"asc"` or `"desc"`; anything else throws.
- Every `column` / table name passed dynamically is re-validated against the
  identifier rules in §3.2.
- `boolean` values bound through `insert`/`update` are coerced to `1`/`0`.
- `insert` returns the freshly inserted row (including generated `id`,
  `createdAt`, `updatedAt`).

#### 3.4.3 `ctx.env`

`Record<string, string>` loaded from `.env.pond.server` (`KEY=VALUE`, `#`
comments). `GOOGLE_REDIRECT_URI` is derived from the dev port when not set.

#### 3.4.4 `ctx.log` — `CapsuleLog`

```ts
interface CapsuleLog {
  info(msg: string, data?: any): void
  error(msg: string, data?: any): void
}
```

#### 3.4.5 `ctx.ai` — `CapsuleAi`

```ts
interface AiCompleteOptions {
  prompt: string
  model?: string
  system?: string
  maxTokens?: number
  temperature?: number
}
interface CapsuleAi {
  complete(opts: AiCompleteOptions): Promise<string>
  stream(opts: AiCompleteOptions): AsyncIterable<string>
}
```

Provider is chosen from env: explicit `AI_PROVIDER=anthropic|openai|hermes`,
else first of `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `HERMES_BASE_URL`. With
none configured, `complete`/`stream` throw. In v1, `stream` yields a single full
string (non-progressive fallback).

#### 3.4.6 `ctx.blob` — `CapsuleBlob`

```ts
interface CapsuleBlob {
  put(
    key: string,
    bytes: Uint8Array | ArrayBuffer | Buffer | string,
    options?: { contentType?: string },
  ): Promise<{ key: string; size: number }>
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<Array<{ key: string; size: number; contentType: string }>>
}
```

Keys **MUST** match `/^[A-Za-z0-9._/-]+$/`, **MUST NOT** contain `..`, and
**MUST NOT** start with `/`; otherwise `put`/`get` throw. Blobs are readable over
the wire at `GET /api/blob/<key>` with **no** built-in access control (§5.5).

### 3.5 Handlers

```ts
type QueryHandler<TArgs extends any[] = any[], TResult = any> =
  (ctx: CapsuleContext, ...args: TArgs) => TResult | Promise<TResult>

type MutationHandler<TArgs extends any[] = any[], TResult = any> =
  (ctx: CapsuleContext, ...args: TArgs) => TResult | Promise<TResult>

query<TArgs extends any[], TResult>(handler: QueryHandler<TArgs, TResult>): QueryHandler<TArgs, TResult>
mutation<TArgs extends any[], TResult>(handler: MutationHandler<TArgs, TResult>): MutationHandler<TArgs, TResult>
```

`query()` / `mutation()` are identity wrappers that mark a function. The return
value **MUST** be JSON-serializable; it is sent back via `c.json(result)`. A
mutation **MAY** return nothing (`void`) — the response is then an empty body
(see §5.2/§5.3 and §4.1 for how the client handles that).

### 3.6 Endpoints

```ts
interface EndpointRequest {
  headers: Headers
  query: Record<string, string>
  json<T>(): Promise<T>
  text(): Promise<string>
  bytes(): Promise<ArrayBuffer>
}
interface EndpointResponse {
  body: string | null
  status: number
  headers: Record<string, string>
}
type EndpointHandler =
  (ctx: CapsuleContext, req: EndpointRequest) => EndpointResponse | Promise<EndpointResponse>

endpoint(opts: { method: string; path: string }, handler: EndpointHandler): EndpointDefinition
```

Use `endpoint(...)` for custom HTTP routes (webhooks, REST). Response helpers:

```ts
json(body: any, init?: { status?: number; headers?: Record<string, string> }): EndpointResponse
  // → application/json, status 200 default
text(body: string, init?: { status?: number; headers?: Record<string, string> }): EndpointResponse
  // → text/plain, status 200 default
```

### 3.7 Sockets and rate limits

```ts
interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: "message", listener: (data: string) => void): void
  on(event: "close", listener: () => void): void
}
type SocketHandler = (ctx: CapsuleContext, socket: SocketLike) => void | Promise<void>
socket(handler: SocketHandler): SocketDefinition

interface RouteRateLimit {
  perMinute?: number
  perHour?: number
  by?: "ip" | "user"   // default "ip"
}
```

`rateLimit[name]` applies to the query/mutation/endpoint of that name. Over-limit
requests get `429` with `{ "error": "Rate limited" }` and `Retry-After: 60`.
Buckets are rolling and in-process (reset on restart).

---

## 4. Client API contract (`pond/client`)

All signatures below are taken verbatim from `client/index.ts`.

### 4.1 `useQuery`

```ts
useQuery<T = any, TArgs extends any[] = []>(name: string, ...args: TArgs): {
  data: T | undefined
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
}
```

Semantics:

- **No args** ⇒ `GET /api/query/<name>`.
- **With args** ⇒ `POST /api/query/<name>` with body `{"args":[...]}`. The args
  array is spread into the server handler after `ctx`.
- **Args are the cache key.** The args are `JSON.stringify`-ed; when they change,
  the query refetches automatically (the empty-args key is `""`).
- `data` is the most recent successful response (`undefined` before first load).
- `isLoading` is `true` during the first load and during any refetch.
- `error` is set when the last fetch threw and cleared on the next successful
  refetch.
- An empty response body parses to `undefined` (mutations returning void).
- A non-2xx response throws `Error: API error: <status>`.
- **Auto-refetch:** every active `useQuery` (across all components, keyed by the
  shared listener registry) refetches whenever **any** `useMutation` completes
  successfully. This is intentionally aggressive; capsules are small apps.

### 4.2 `useMutation`

```ts
useMutation<TArgs extends any[] = any[], TResult = any>(name: string):
  [(...args: TArgs) => Promise<TResult>, { isLoading: boolean; error: Error | null }]
```

- Returns `[run, state]`. `run(...args)` ⇒ `POST /api/mutation/<name>` with body
  `{"args":[...]}` (positional args matching the server mutation).
- On success it resolves with the parsed result **and** triggers a refetch of
  every active query.
- On failure it sets `state.error` and re-throws.

### 4.3 `useAuth`

```ts
interface AuthState {
  isLoading: boolean
  isGuest: boolean
  userId: string
  displayName?: string
  picture?: string
  email?: string
}
useAuth(): AuthState
```

Reads `GET /auth/me`. Default before load: `{ isLoading: true, isGuest: true,
userId: "guest" }`. Listens for the `pond:auth-changed` window event and
refetches when it fires.

### 4.4 `SignInWithGoogle` / `signOut`

```ts
SignInWithGoogle(props?: Record<string, any>): VNode   // a <button>
signOut(): Promise<void>
```

- `SignInWithGoogle` renders a button that navigates to `/auth/google` on click.
  Any HTML button props pass through; an `onClick` that calls
  `event.preventDefault()` suppresses the navigation.
- `signOut()` `POST`s `/auth/signout` then dispatches `pond:auth-changed` so
  every `useAuth` consumer refreshes.

### 4.5 `render`, `h`

Re-exported from Preact. Most capsules never call these directly — the runtime's
HTML shell mounts `<App />`.

---

## 5. Wire protocol

A conformant runtime mounts the following routes for a capsule. Bodies are JSON
unless stated. Request bodies are sent with `content-type: application/json`. This
section is sufficient to implement a compatible runtime from scratch.

### 5.1 `GET /api/query/<name>`

Mounted for every key in `def.queries`. No request body. Calls
`handler(ctx)` with **no** extra args.

- **200**: `c.json(result)` — the handler's return value, JSON-encoded.
- **429**: `{ "error": "Rate limited" }`, header `Retry-After: 60`, if the
  named route is rate-limited and over budget.

### 5.2 `POST /api/query/<name>`

Mounted for every key in `def.queries` (in addition to the GET). Used for
parameterized reads.

- **Request body**: `{ "args": [...] }`. If `args` is missing or not an array,
  it is treated as `[]`. The array is spread: `handler(ctx, ...args)`.
- **200**: `c.json(result)`.
- **429**: as in §5.1.

### 5.3 `POST /api/mutation/<name>`

Mounted for every key in `def.mutations`.

- **Request body**: `{ "args": [...] }`. `args` is read as `body.args ?? []`
  and spread: `handler(ctx, ...args)`. (Note: a non-array `args` here is **not**
  re-coerced to `[]` — clients always send an array.)
- **200**: `c.json(result)`. A `void` return serializes to an empty/`null`
  body, which the client parses to `undefined`.
- **429**: as in §5.1.

### 5.4 `<method> <path>` — custom endpoints

For every key in `def.endpoints`:

- If the value is an `endpoint({ method, path }, handler)`, the route is
  `method.toLowerCase()` at `path` (e.g. `POST /webhooks/stripe`).
- If the value is a bare handler function (no `_method`/`_path`), the route
  defaults to `GET /api/<name>`.
- The handler receives `(ctx, req)` where `req` is an `EndpointRequest` backed by
  the underlying HTTP request. The returned `EndpointResponse`
  (`{ body, status, headers }`) is written back verbatim.
- Rate limiting by endpoint name applies (§3.7).

### 5.5 `GET /api/blob/<key>`

Returns the blob bytes with the stored `content-type`. **No access control.**

- **200**: raw bytes, `content-type` = stored type.
- **404**: `{ "error": "Not found" }`.

`<key>` may contain `/`. Keys with `..` / leading `/` are rejected by the
blob layer.

### 5.6 Auth routes (built-in)

| Method | Path                        | Purpose                                              |
| ------ | --------------------------- | ---------------------------------------------------- |
| GET    | `/auth/me`                  | Returns the current `CapsuleAuth` as JSON.           |
| POST   | `/auth/signout`             | Clears the session cookie; returns `{ "ok": true }`. |
| GET    | `/auth/google`              | Redirect to Google OAuth (if configured).            |
| GET    | `/auth/google/callback`     | OAuth callback → sets `pond_session` → redirect `/`. |
| GET    | `/auth/github`              | Redirect to GitHub OAuth (if configured).            |
| GET    | `/auth/github/callback`     | OAuth callback → sets `pond_session` → redirect `/`. |
| POST   | `/auth/email/request`       | Body `{ email }`; issues a 15-min magic-link token.  |
| GET    | `/auth/email/verify?token=` | Consumes the token → sets session → redirect `/`.    |

Session cookie is `pond_session` (HttpOnly, SameSite=Lax, JWT, 7-day expiry).

### 5.7 Operational routes

| Method | Path                | Purpose                                                                        |
| ------ | ------------------- | ------------------------------------------------------------------------------ |
| GET    | `/__pond/metrics`   | Prometheus text: per-route request/error counts, p50/p95/p99 latency. No auth. |
| GET    | `/favicon.svg` etc. | Built-in favicons.                                                             |

### 5.8 Error shapes

- Wire-level (client `apiFetch`): any non-2xx ⇒ the client throws
  `Error: API error: <status>`.
- Rate limit: `429` with JSON `{ "error": "Rate limited" }` and `Retry-After: 60`.
- Blob miss: `404` with JSON `{ "error": "Not found" }`.
- Handler exceptions propagate as the runtime's default error response (and are
  counted as route errors in `/__pond/metrics`).

---

## 6. CORS

Cross-origin browser requests are rejected by default — the runtime emits **no**
`Access-Control-Allow-Origin` for them. A capsule opts extra origins in via
`allowedOrigins: string[]` on `capsule({...})`.

---

## 7. Conformance checklist

An agent emitting a capsule **MUST** be able to answer "yes" to all of these:

- [ ] Directory has `server/index.ts`, `client/index.tsx`, and `package.json`.
- [ ] `server/index.ts` ends with `export default capsule({ schema, queries, mutations, ... })`.
- [ ] `server/index.ts` imports only from `pond/server`, relative TS, and Node built-ins — no npm packages.
- [ ] `client/index.tsx` exports a Preact component named `App`.
- [ ] `client/index.tsx` imports only from `pond/client` and relative TS — no React/react-query/etc.
- [ ] Any `shared/` file is pure TS (no env, DOM, Node, or pond runtime APIs).
- [ ] All table & column names match `/^[A-Za-z_][A-Za-z0-9_]*$/`, ≤64 chars, no `_pond_` prefix, not a SQLite reserved word.
- [ ] Schema columns use only `string()`, `number()`, `boolean()`; no hand-built `ColumnType`.
- [ ] The client talks to the server only through `useQuery`/`useMutation` — no manual `fetch` to `/api/...`.
- [ ] Every handler enforces its own authorization via `ctx.auth` (filter reads; re-check ownership on update/delete).
- [ ] `package.json` declares no npm lifecycle scripts.
- [ ] Mutation/query return values are JSON-serializable.

---

## 8. Conformance notes & known doc drift

These are discrepancies between the runtime source and the prior prose docs as of
this spec. The **code is authoritative**; this spec follows the code.

1. **`ctx` shape.** `docs/api-reference.md` and `README.md` describe
   `CapsuleContext` as `{ auth, db, env, log }`. The actual context built by the
   runtime always also includes `ai` and `blob` (documented in this spec at
   §3.4.5 / §3.4.6).
2. **`socket()` export.** `socket()` is a real export of `pond/server` and is
   used in `docs/api-reference.md`, but `README.md`'s "Public Server API" list and
   the agent "hard rules" omit it. WebSockets work in the local dev / `pond start`
   runtime; the hosted control plane does **not** proxy them in v1 (README:
   "No WebSocket support through the proxy"). Treat sockets as a local-only
   capability for v1.
3. **POST query vs mutation arg coercion.** For `POST /api/query/<name>` the
   runtime coerces a non-array `args` to `[]`. For `POST /api/mutation/<name>` it
   uses `body.args ?? []` with no array check. The client always sends an array,
   so this only matters for hand-crafted requests.
4. **Bare-function endpoints.** `capsule()` accepts an endpoint value that is a
   bare handler function (not wrapped in `endpoint(...)`). Such an endpoint has no
   method/path and the runtime defaults it to `GET /api/<name>`. Prefer the
   explicit `endpoint({ method, path }, handler)` form.
5. **Fork / source route naming.** `docs/cli-reference.md` references
   `/api/deploys/<id>/source` for `pond fork`, while `docs/api-reference.md`
   documents `/api/public-deploys/:id/source` for `public: true` capsules. These
   are control-plane (not capsule-runtime) routes and are out of scope for this
   capsule format spec; noted here only to flag the inconsistency.

---

## 9. Minimal worked example (valid per Spec v1)

A tiny todo capsule: one table, one query, one mutation, server-owned writes,
per-user filtering.

### `server/index.ts`

```ts
import { capsule, query, mutation, table, string, boolean } from "pond/server"

export default capsule({
  title: "Todos",
  schema: {
    todos: table({
      text: string(),
      done: boolean(),
      owner: string(),
    }),
  },
  queries: {
    // No-arg read — hit via useQuery("todos").
    todos: query((ctx) => ctx.db.todos.where("owner", ctx.auth.userId).orderBy("createdAt", "desc").all()),
  },
  mutations: {
    addTodo: mutation((ctx, text: string) => ctx.db.todos.insert({ text, done: false, owner: ctx.auth.userId })),
    toggleTodo: mutation((ctx, id: string) => {
      const row = ctx.db.todos.get(id)
      if (!row || row.owner !== ctx.auth.userId) throw new Error("not found")
      return ctx.db.todos.update(id, { done: !row.done })
    }),
  },
})
```

### `client/index.tsx`

```tsx
import { useQuery, useMutation } from "pond/client"

interface Todo {
  id: string
  text: string
  done: number
  owner: string
}

export function App() {
  const { data: todos } = useQuery<Todo[]>("todos")
  const [addTodo] = useMutation<[string], Todo>("addTodo")
  const [toggleTodo] = useMutation<[string], Todo>("toggleTodo")

  return (
    <div class="mx-auto max-w-md p-6">
      <h1 class="mb-4 text-xl font-bold">Todos</h1>
      <form
        class="mb-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          const input = (e.currentTarget as HTMLFormElement).elements.namedItem("text") as HTMLInputElement
          if (input.value.trim()) {
            await addTodo(input.value.trim())
            input.value = ""
          }
        }}
      >
        <input name="text" class="flex-1 rounded border px-2 py-1" placeholder="Add a todo" />
        <button type="submit" class="rounded bg-black px-3 py-1 text-white">
          Add
        </button>
      </form>
      <ul class="space-y-1">
        {todos?.map((t) => (
          <li key={t.id} class="flex items-center gap-2">
            <input type="checkbox" checked={!!t.done} onChange={() => toggleTodo(t.id)} />
            <span class={t.done ? "line-through opacity-50" : ""}>{t.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

This example uses only `pond/server` / `pond/client` exports, exports `App`,
keeps writes server-side, filters by `ctx.auth.userId`, re-checks ownership on
`toggleTodo`, and uses only `string()` / `boolean()` columns — satisfying every
item in the §7 checklist.
