import { Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import Database from "better-sqlite3"
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { pathToFileURL } from "node:url"
import { SignJWT, jwtVerify } from "jose"
import { confineImportsTo } from "./build-confinement.js"
import { containedRealPath } from "./host/fs-safe.js"
import {
  CapsuleAi,
  CapsuleAuth,
  CapsuleBlob,
  CapsuleContext,
  CapsuleDefinition,
  CapsuleShopify,
  ColumnType,
} from "./server/index.js"

interface ServerModule {
  default: CapsuleDefinition
}

interface RuntimeOptions {
  port?: number
  getGuestAuth?: () => CapsuleAuth
  onLog?: (entry: { timestamp: string; level: "info" | "error"; message: string; data?: any }) => void
}

interface SessionPayload {
  userId: string
  displayName?: string
  picture?: string
  email?: string
}

const SESSION_COOKIE = "pond_session"
const OAUTH_STATE_COOKIE = "pond_google_oauth_state"
const OAUTH_VERIFIER_COOKIE = "pond_google_oauth_verifier"
const GITHUB_STATE_COOKIE = "pond_github_oauth_state"

// Outbound calls from capsule code (AI providers, Shopify, Resend, OAuth
// userinfo) must not hang a request forever on a stalled upstream. 30s covers
// every one of these APIs' worst legitimate latency; anything slower is a
// failure worth surfacing, not waiting on.
const UPSTREAM_TIMEOUT_MS = 30_000
function upstreamFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
}

export async function createRuntime(
  serverFile: string,
  cwd: string,
  options: RuntimeOptions = {},
): Promise<{
  mount: (app: Hono) => void
  db: Database.Database
  def: CapsuleDefinition
  env: Record<string, string>
  buildContext: (cookieHeader: string | null | undefined) => Promise<CapsuleContext>
  close: () => void
}> {
  // Build-time only. Dynamic so the hosted capsule worker (which imports this
  // module via createRuntimeFromDeployBundle and never builds) doesn't carry
  // esbuild's ~5 MB resident weight in every running deploy.
  const esbuild = await import("esbuild")
  const result = await esbuild.build({
    entryPoints: [serverFile],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2020",
    platform: "node",
    packages: "external",
    alias: {
      "pond/server": path.resolve(import.meta.dirname, "../src/server/index.ts"),
    },
  })

  const js = result.outputFiles[0].text
  const tmpFile = path.join(cwd, ".pond", "server.mjs")
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
  fs.writeFileSync(tmpFile, js)

  const mod: ServerModule = await import(`${pathToFileURL(tmpFile).href}?t=${Date.now()}`)

  return createRuntimeFromDefinition(mod.default, cwd, options)
}

export async function createRuntimeFromDeployBundle(
  bundleFile: string,
  cwd: string,
  options: RuntimeOptions = {},
): Promise<{
  mount: (app: Hono) => void
  db: Database.Database
  def: CapsuleDefinition
  env: Record<string, string>
  buildContext: (cookieHeader: string | null | undefined) => Promise<CapsuleContext>
  close: () => void
}> {
  const mod: ServerModule = await import(`${pathToFileURL(bundleFile).href}?t=${Date.now()}`)
  return createRuntimeFromDefinition(mod.default, cwd, options)
}

interface RouteMetric {
  count: number
  errors: number
  totalMs: number
  durations: number[]
}

function createMetric(): RouteMetric {
  return { count: 0, errors: 0, totalMs: 0, durations: [] }
}

function recordMetric(m: RouteMetric, ms: number, errored: boolean) {
  m.count += 1
  m.totalMs += ms
  if (errored) m.errors += 1
  m.durations.push(ms)
  if (m.durations.length > 500) m.durations.shift()
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)))
  return sorted[idx]
}

function renderPrometheus(metrics: Map<string, RouteMetric>): string {
  const lines: string[] = []
  lines.push("# HELP pond_route_requests_total Total requests per route")
  lines.push("# TYPE pond_route_requests_total counter")
  for (const [route, m] of metrics) {
    lines.push(`pond_route_requests_total{route="${route}"} ${m.count}`)
  }
  lines.push("# HELP pond_route_errors_total Total errored requests per route")
  lines.push("# TYPE pond_route_errors_total counter")
  for (const [route, m] of metrics) {
    lines.push(`pond_route_errors_total{route="${route}"} ${m.errors}`)
  }
  lines.push("# HELP pond_route_duration_ms Route duration percentiles (rolling 500 samples)")
  lines.push("# TYPE pond_route_duration_ms summary")
  for (const [route, m] of metrics) {
    const sorted = [...m.durations].sort((a, b) => a - b)
    lines.push(`pond_route_duration_ms{route="${route}",quantile="0.5"} ${percentile(sorted, 0.5)}`)
    lines.push(`pond_route_duration_ms{route="${route}",quantile="0.95"} ${percentile(sorted, 0.95)}`)
    lines.push(`pond_route_duration_ms{route="${route}",quantile="0.99"} ${percentile(sorted, 0.99)}`)
    lines.push(`pond_route_duration_ms_count{route="${route}"} ${m.count}`)
    lines.push(`pond_route_duration_ms_sum{route="${route}"} ${m.totalMs}`)
  }
  return lines.join("\n") + "\n"
}

interface RateBucket {
  windowStart: number
  count: number
}

function applyMigrations(db: Database.Database, schema: Record<string, Record<string, ColumnType>>): void {
  // Built-in tables. Idempotent — these are infrastructure, not user schema.
  db.exec("CREATE TABLE IF NOT EXISTS _pond_migrations (name TEXT PRIMARY KEY)")
  db.exec(
    "CREATE TABLE IF NOT EXISTS _pond_users (id TEXT PRIMARY KEY, googleId TEXT UNIQUE, githubId TEXT UNIQUE, displayName TEXT, picture TEXT, email TEXT UNIQUE, createdAt TEXT DEFAULT (datetime('now')), updatedAt TEXT DEFAULT (datetime('now')))",
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS _pond_magic_links (token TEXT PRIMARY KEY, email TEXT NOT NULL, expiresAt TEXT NOT NULL, usedAt TEXT)",
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS _pond_blobs (key TEXT PRIMARY KEY, contentType TEXT, size INTEGER NOT NULL, createdAt TEXT DEFAULT (datetime('now')))",
  )

  // Lightweight migration of older _pond_users rows.
  const userCols = (db.prepare("PRAGMA table_info(_pond_users)").all() as Array<{ name: string }>).map((c) => c.name)
  if (!userCols.includes("githubId")) db.exec("ALTER TABLE _pond_users ADD COLUMN githubId TEXT")

  for (const [tableName, columns] of Object.entries(schema)) {
    assertIdent(tableName)
    const existsRow = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
      | { name?: string }
      | undefined

    if (!existsRow) {
      const colDefs = Object.entries(columns).map(([col, type]) => {
        return `${quoteIdent(col)} ${type._sqlType}`
      })
      colDefs.push("id TEXT PRIMARY KEY")
      colDefs.push("createdAt TEXT DEFAULT (datetime('now'))")
      colDefs.push("updatedAt TEXT DEFAULT (datetime('now'))")

      db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (${colDefs.join(", ")})`)
      db.prepare("INSERT OR IGNORE INTO _pond_migrations (name) VALUES (?)").run(`table_${tableName}`)
      continue
    }

    // Table already exists — diff columns. Add new ones; refuse to drop.
    const existing = (db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    const wantSet = new Set(Object.keys(columns))
    const reserved = new Set(["id", "createdAt", "updatedAt"])

    for (const [col, type] of Object.entries(columns)) {
      if (!existing.includes(col)) {
        db.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(col)} ${type._sqlType}`)
      }
    }
    const removed = existing.filter((c) => !wantSet.has(c) && !reserved.has(c))
    if (removed.length) {
      throw new Error(
        `Refusing to apply destructive schema change to table "${tableName}": columns ${removed
          .map((c) => `"${c}"`)
          .join(", ")} would be dropped. ` +
          `If this is intentional, drop it on the live database with \`pond db migrate --drop ${tableName}.${removed[0]}\`, ` +
          `or rename it with \`pond db migrate --rename ${tableName}.${removed[0]} --to <newColumn>\`, then redeploy.`,
      )
    }
  }
}

function createAi(env: Record<string, string>): CapsuleAi {
  const provider = (env.AI_PROVIDER ?? "").toLowerCase()
  const anthropicKey = env.ANTHROPIC_API_KEY ?? ""
  const openaiKey = env.OPENAI_API_KEY ?? ""
  const hermesUrl = env.HERMES_BASE_URL || (env.HERMES_ENABLED === "1" ? "http://127.0.0.1:8642" : "")

  function pick(): "anthropic" | "openai" | "hermes" {
    if (provider === "anthropic" || provider === "openai" || provider === "hermes") return provider
    if (anthropicKey) return "anthropic"
    if (openaiKey) return "openai"
    if (hermesUrl) return "hermes"
    throw new Error(
      "ctx.ai: no provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or HERMES_BASE_URL in .env.pond.server.",
    )
  }

  async function completeAnthropic(o: {
    prompt: string
    model?: string
    system?: string
    maxTokens?: number
    temperature?: number
  }) {
    const res = await upstreamFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: o.model ?? "claude-sonnet-4-6",
        max_tokens: o.maxTokens ?? 1024,
        temperature: o.temperature ?? 1,
        system: o.system,
        messages: [{ role: "user", content: o.prompt }],
      }),
    })
    if (!res.ok) throw new Error(`anthropic: ${res.status} ${await res.text()}`)
    const j = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    return j.content?.find((b) => b.type === "text")?.text ?? ""
  }

  async function completeOpenAi(o: {
    prompt: string
    model?: string
    system?: string
    maxTokens?: number
    temperature?: number
  }) {
    const res = await upstreamFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${openaiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: o.model ?? "gpt-4o-mini",
        max_tokens: o.maxTokens,
        temperature: o.temperature,
        messages: [...(o.system ? [{ role: "system", content: o.system }] : []), { role: "user", content: o.prompt }],
      }),
    })
    if (!res.ok) throw new Error(`openai: ${res.status} ${await res.text()}`)
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return j.choices?.[0]?.message?.content ?? ""
  }

  async function completeHermes(o: {
    prompt: string
    model?: string
    system?: string
    maxTokens?: number
    temperature?: number
  }) {
    const res = await upstreamFetch(`${hermesUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: o.model ?? "hermes",
        max_tokens: o.maxTokens,
        temperature: o.temperature,
        messages: [...(o.system ? [{ role: "system", content: o.system }] : []), { role: "user", content: o.prompt }],
      }),
    })
    if (!res.ok) throw new Error(`hermes: ${res.status} ${await res.text()}`)
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return j.choices?.[0]?.message?.content ?? ""
  }

  return {
    async complete(o) {
      const p = pick()
      if (p === "anthropic") return completeAnthropic(o)
      if (p === "openai") return completeOpenAi(o)
      return completeHermes(o)
    },
    async *stream(o) {
      // Simple non-streaming fallback. Streaming differs per provider; ship a
      // single yield until callers actually need progressive output.
      const full = await this.complete(o)
      yield full
    },
  }
}

function createBlob(cwd: string, db: Database.Database): CapsuleBlob {
  const dir = path.join(cwd, ".pond", "blobs")
  fs.mkdirSync(dir, { recursive: true })
  const ins = db.prepare(
    "INSERT INTO _pond_blobs (key, contentType, size) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET contentType = excluded.contentType, size = excluded.size",
  )
  const getMeta = db.prepare("SELECT key, contentType, size FROM _pond_blobs WHERE key = ?")
  const del = db.prepare("DELETE FROM _pond_blobs WHERE key = ?")
  const list = db.prepare(
    "SELECT key, contentType, size FROM _pond_blobs WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC",
  )

  function keyToPath(key: string): string {
    if (!/^[A-Za-z0-9._/-]+$/.test(key)) throw new Error(`invalid blob key: ${key}`)
    if (key.includes("..") || key.startsWith("/")) throw new Error(`invalid blob key: ${key}`)
    return path.join(dir, key)
  }

  return {
    async put(key, bytes, options) {
      const p = keyToPath(key)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const buf =
        typeof bytes === "string"
          ? Buffer.from(bytes, "utf-8")
          : bytes instanceof Buffer
            ? bytes
            : Buffer.from(bytes as ArrayBuffer)
      fs.writeFileSync(p, buf)
      ins.run(key, options?.contentType ?? "application/octet-stream", buf.length)
      return { key, size: buf.length }
    },
    async get(key) {
      const meta = getMeta.get(key) as { key: string; contentType: string; size: number } | undefined
      if (!meta) return null
      const p = keyToPath(key)
      if (!fs.existsSync(p)) return null
      return { bytes: fs.readFileSync(p), contentType: meta.contentType }
    },
    async delete(key) {
      const p = keyToPath(key)
      try {
        fs.unlinkSync(p)
      } catch {
        // best effort
      }
      del.run(key)
    },
    async list(prefix) {
      // Escape LIKE wildcards in the prefix so a key containing `%` or `_`
      // lists only itself, not every key sharing the wildcard characters.
      const escaped = (prefix ?? "").replace(/[\\%_]/g, (c) => `\\${c}`)
      const rows = list.all(`${escaped}%`) as Array<{ key: string; contentType: string; size: number }>
      return rows
    },
  }
}

export function createShopify(env: Record<string, string>): CapsuleShopify {
  return {
    async graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const shop = env.SHOPIFY_SHOP
      const token = env.SHOPIFY_TOKEN
      if (!shop || !token) {
        throw new Error("Set SHOPIFY_SHOP and SHOPIFY_TOKEN via `pond env set` to use ctx.shopify.graphql()")
      }

      // Normalize shop domain: accept "my-store" or "my-store.myshopify.com"
      let domain = shop.trim().toLowerCase()
      domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
      if (!domain.endsWith(".myshopify.com")) {
        domain = `${domain}.myshopify.com`
      }

      const apiVersion = env.SHOPIFY_API_VERSION || "2025-01"
      const url = `https://${domain}/admin/api/${apiVersion}/graphql.json`

      const res = await upstreamFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      })

      const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }

      if (!res.ok) {
        const errMsg = body.errors?.[0]?.message ?? `HTTP ${res.status}`
        throw new Error(`Shopify API error: ${errMsg}`)
      }

      if (body.errors && body.errors.length > 0) {
        throw new Error(`Shopify GraphQL error: ${body.errors[0].message}`)
      }

      return body.data as T
    },
  }
}

function createRuntimeFromDefinition(
  def: CapsuleDefinition,
  cwd: string,
  options: RuntimeOptions = {},
): {
  mount: (app: Hono) => void
  db: Database.Database
  def: CapsuleDefinition
  env: Record<string, string>
  buildContext: (cookieHeader: string | null | undefined) => Promise<CapsuleContext>
  close: () => void
} {
  const dbPath = path.join(cwd, ".pond", "data.db")
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")

  applyMigrations(db, def.schema)

  const env = loadEnv(cwd, options.port ?? 3000)
  const dbProxy = buildDbProxy(db, def.schema)
  const ai = createAi(env)
  const blob = createBlob(cwd, db)
  let sessionSecretSource = env.POND_SESSION_SECRET || env.GOOGLE_CLIENT_SECRET
  if (!sessionSecretSource) {
    sessionSecretSource = randomBytes(32).toString("hex")
    console.warn(
      "[pond] WARNING: no POND_SESSION_SECRET set — generated an ephemeral secret. Sessions will not survive restart. Set POND_SESSION_SECRET in .env.pond.server for production.",
    )
  }
  const sessionSecret = new TextEncoder().encode(sessionSecretSource)
  const guestAuth = options.getGuestAuth ?? (() => ({ isGuest: true, userId: "guest", displayName: "Guest" }))
  const googleConfigured = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI)
  const githubConfigured = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
  // Lazy-load `arctic` (the OAuth client lib, ~5 MB resident) only when an OAuth
  // route is actually hit on a configured capsule. The common no-OAuth capsule
  // never imports it, shrinking the per-worker memory floor. OAuth flows are
  // low-frequency, so reconstructing the client per request is negligible.
  let arcticMod: typeof import("arctic") | undefined
  const loadArctic = async () => (arcticMod ??= await import("arctic"))
  const getGoogle = async () => {
    if (!googleConfigured) return null
    const { Google } = await loadArctic()
    return new Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI)
  }
  const getGitHub = async () => {
    if (!githubConfigured) return null
    const { GitHub } = await loadArctic()
    return new GitHub(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, env.GITHUB_REDIRECT_URI || null)
  }

  const log = (level: "info" | "error", message: string, data?: any) => {
    const entry = { timestamp: new Date().toISOString(), level, message, data }
    options.onLog?.(entry)
    if (level === "info") {
      console.log(`[pond] ${message}`, data ?? "")
    } else {
      console.error(`[pond] ${message}`, data ?? "")
    }
  }

  const metrics = new Map<string, RouteMetric>()
  const rateBuckets = new Map<string, RateBucket>()

  // Expired buckets are otherwise only replaced when their key returns —
  // every distinct visitor (or spoofed forwarded-header value) permanently
  // adds entries. Sweep them so a long-lived worker's map stays bounded.
  const rateSweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [bk, b] of rateBuckets) {
      if (now - b.windowStart > 3_600_000) rateBuckets.delete(bk)
    }
  }, 5 * 60_000)
  rateSweepTimer.unref()

  function rateAllow(
    route: string,
    key: string,
    perMinute: number | undefined,
    perHour: number | undefined,
  ): { ok: boolean; retryAfterSeconds: number } {
    const now = Date.now()
    let retryAfterSeconds = 0
    if (typeof perMinute === "number") {
      const bk = `m:${route}:${key}`
      const cur = rateBuckets.get(bk)
      if (!cur || now - cur.windowStart > 60_000) {
        rateBuckets.set(bk, { windowStart: now, count: 1 })
      } else {
        cur.count += 1
        if (cur.count > perMinute) {
          retryAfterSeconds = Math.max(1, Math.ceil((cur.windowStart + 60_000 - now) / 1000))
        }
      }
    }
    if (retryAfterSeconds === 0 && typeof perHour === "number") {
      const bk = `h:${route}:${key}`
      const cur = rateBuckets.get(bk)
      if (!cur || now - cur.windowStart > 3_600_000) {
        rateBuckets.set(bk, { windowStart: now, count: 1 })
      } else {
        cur.count += 1
        if (cur.count > perHour) {
          retryAfterSeconds = Math.max(1, Math.ceil((cur.windowStart + 3_600_000 - now) / 1000))
        }
      }
    }
    return { ok: retryAfterSeconds === 0, retryAfterSeconds }
  }

  async function resolveAuth(cookies: string | null | undefined): Promise<CapsuleAuth> {
    if (!cookies) return guestAuth()
    const sessionToken = readCookieValue(cookies, SESSION_COOKIE)
    if (!sessionToken) return guestAuth()

    try {
      const { payload } = await jwtVerify(sessionToken, sessionSecret)
      return {
        isGuest: false,
        userId: String(payload.userId),
        displayName: payload.displayName ? String(payload.displayName) : undefined,
        picture: payload.picture ? String(payload.picture) : undefined,
        email: payload.email ? String(payload.email) : undefined,
      }
    } catch {
      return guestAuth()
    }
  }

  async function buildContext(cookieHeader: string | null | undefined): Promise<CapsuleContext> {
    return {
      db: dbProxy,
      // Atomic multi-step mutations. better-sqlite3 runs `fn` inside BEGIN/COMMIT
      // (ROLLBACK if it throws), so a handler that does several writes either
      // applies all of them or none — no partial state on error. `fn` must be
      // synchronous (all ctx.db operations are); returning a promise throws.
      transaction: <T>(fn: () => T): T => db.transaction(fn)(),
      auth: await resolveAuth(cookieHeader),
      env,
      ai,
      blob,
      shopify: createShopify(env),
      log: {
        info: (message: string, data?: any) => log("info", message, data),
        error: (message: string, data?: any) => log("error", message, data),
      },
    }
  }

  function signSession(payload: SessionPayload): Promise<string> {
    return new SignJWT(payload as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(sessionSecret)
  }

  function upsertUser(row: {
    id: string
    googleId?: string
    githubId?: string
    displayName?: string
    picture?: string
    email?: string
  }) {
    db.prepare(
      "INSERT INTO _pond_users (id, googleId, githubId, displayName, picture, email) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET googleId = COALESCE(excluded.googleId, _pond_users.googleId), githubId = COALESCE(excluded.githubId, _pond_users.githubId), displayName = excluded.displayName, picture = excluded.picture, email = excluded.email, updatedAt = datetime('now')",
    ).run(
      row.id,
      row.googleId ?? null,
      row.githubId ?? null,
      row.displayName ?? null,
      row.picture ?? null,
      row.email ?? null,
    )
  }

  function mount(app: Hono) {
    const FAVICON_RIPPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#09090b"/><g fill="none" stroke="#67e8f9" stroke-linecap="round"><circle cx="16" cy="18" r="7" stroke-width="1.5"/><circle cx="16" cy="18" r="4" stroke-width="1.5"/></g><circle cx="16" cy="11.5" r="1.3" fill="#67e8f9"/></svg>`
    const FAVICON_DROP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#09090b"/><path d="M16 6.5c-3 4.7-6 7.6-6 11A6 6 0 0 0 22 17.5c0-3.4-3-6.3-6-11Z" fill="#67e8f9"/><path d="M12 21.4c2.5-1 5.5-1 8 0" fill="none" stroke="#67e8f9" stroke-width="1.5" stroke-linecap="round"/></svg>`
    const FAVICON_P = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#09090b"/><path d="M12 8h4.5A5.5 5.5 0 0 1 22 13.5 5.5 5.5 0 0 1 16.5 19H15v7h-3Z" fill="#67e8f9"/><circle cx="17" cy="13.5" r="3.2" fill="#09090b"/></svg>`
    const FAVICON_MONO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"><circle cx="16" cy="18" r="7"/><circle cx="16" cy="18" r="4"/></g><circle cx="16" cy="11.5" r="1.3" fill="currentColor"/></svg>`
    const FAVICON_SVG = FAVICON_RIPPLE
    app.get(
      "/favicon.svg",
      (c) =>
        new Response(FAVICON_SVG, {
          status: 200,
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        }),
    )
    app.get(
      "/favicon-mono.svg",
      (c) =>
        new Response(FAVICON_MONO, {
          status: 200,
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        }),
    )
    app.get(
      "/favicon.ico",
      (c) =>
        new Response(FAVICON_SVG, {
          status: 200,
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        }),
    )

    // ── Google OAuth (unchanged from previous implementation) ───
    app.get("/auth/google", async (c) => {
      const google = await getGoogle()
      if (!google) return c.text("Missing Google OAuth configuration", 500)
      const { generateState, generateCodeVerifier } = await loadArctic()
      const state = generateState()
      const codeVerifier = generateCodeVerifier()
      const url = google.createAuthorizationURL(state, codeVerifier, ["openid", "profile", "email"])
      setCookie(c, OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 600 })
      setCookie(c, OAUTH_VERIFIER_COOKIE, codeVerifier, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 600 })
      return c.redirect(url.toString(), 302)
    })

    app.get("/auth/google/callback", async (c) => {
      const google = await getGoogle()
      if (!google) return c.text("Missing Google OAuth configuration", 500)
      const code = c.req.query("code")
      const state = c.req.query("state")
      const storedState = getCookie(c, OAUTH_STATE_COOKIE)
      const codeVerifier = getCookie(c, OAUTH_VERIFIER_COOKIE)
      if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
        return c.text("Invalid OAuth callback", 400)
      }
      const tokens = await google.validateAuthorizationCode(code, codeVerifier)
      const userInfoRes = await upstreamFetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${tokens.accessToken()}` },
      })
      if (!userInfoRes.ok) return c.text("Failed to fetch Google user info", 500)
      const userInfo = (await userInfoRes.json()) as { sub: string; name?: string; picture?: string; email?: string }
      upsertUser({
        id: userInfo.sub,
        googleId: userInfo.sub,
        displayName: userInfo.name,
        picture: userInfo.picture,
        email: userInfo.email,
      })
      const session = await signSession({
        userId: userInfo.sub,
        displayName: userInfo.name,
        picture: userInfo.picture,
        email: userInfo.email,
      })
      setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 7 })
      deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" })
      deleteCookie(c, OAUTH_VERIFIER_COOKIE, { path: "/" })
      return c.redirect("/", 302)
    })

    // ── GitHub OAuth ────────────────────────────────────────────
    app.get("/auth/github", async (c) => {
      const github = await getGitHub()
      if (!github) return c.text("Missing GitHub OAuth configuration", 500)
      const { generateState } = await loadArctic()
      const state = generateState()
      const url = github.createAuthorizationURL(state, ["read:user", "user:email"])
      setCookie(c, GITHUB_STATE_COOKIE, state, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 600 })
      return c.redirect(url.toString(), 302)
    })

    app.get("/auth/github/callback", async (c) => {
      const github = await getGitHub()
      if (!github) return c.text("Missing GitHub OAuth configuration", 500)
      const code = c.req.query("code")
      const state = c.req.query("state")
      const storedState = getCookie(c, GITHUB_STATE_COOKIE)
      if (!code || !state || !storedState || state !== storedState) {
        return c.text("Invalid OAuth callback", 400)
      }
      const tokens = await github.validateAuthorizationCode(code)
      const userRes = await upstreamFetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${tokens.accessToken()}`, accept: "application/vnd.github+json" },
      })
      if (!userRes.ok) return c.text("Failed to fetch GitHub user info", 500)
      const gh = (await userRes.json()) as {
        id: number
        login: string
        name?: string
        avatar_url?: string
        email?: string
      }
      // Email may be private; fetch it explicitly if missing.
      let email = gh.email
      if (!email) {
        const emailRes = await upstreamFetch("https://api.github.com/user/emails", {
          headers: { authorization: `Bearer ${tokens.accessToken()}`, accept: "application/vnd.github+json" },
        })
        if (emailRes.ok) {
          const list = (await emailRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>
          email = list.find((e) => e.primary && e.verified)?.email ?? list[0]?.email
        }
      }
      const userId = `github:${gh.id}`
      upsertUser({
        id: userId,
        githubId: String(gh.id),
        displayName: gh.name ?? gh.login,
        picture: gh.avatar_url,
        email,
      })
      const session = await signSession({ userId, displayName: gh.name ?? gh.login, picture: gh.avatar_url, email })
      setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 7 })
      deleteCookie(c, GITHUB_STATE_COOKIE, { path: "/" })
      return c.redirect("/", 302)
    })

    // ── Email magic link ───────────────────────────────────────
    // POST /auth/email/request {email} -> generates a single-use token + emits
    // a log line (in production, plug into an email provider via env). The
    // user clicks the link, which lands on /auth/email/verify?token=...
    app.post("/auth/email/request", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { email?: string }
      const email = (body.email ?? "").trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "invalid email" }, 400)
      const token = randomBytes(24).toString("hex")
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
      db.prepare("INSERT INTO _pond_magic_links (token, email, expiresAt) VALUES (?, ?, ?)").run(
        token,
        email,
        expiresAt,
      )
      const base = env.POND_PUBLIC_BASE_URL ?? `http://localhost:${options.port ?? 3000}`
      const link = `${base.replace(/\/$/, "")}/auth/email/verify?token=${token}`
      // In dev, surface the link via logs. In production, plug a real sender
      // via the EMAIL_FROM + RESEND_API_KEY (or similar) envs and replace this
      // log-only fallback.
      if (env.RESEND_API_KEY && env.EMAIL_FROM) {
        await upstreamFetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: email,
            subject: "Your sign-in link",
            text: `Click to sign in: ${link}\n\nThis link expires in 15 minutes.`,
          }),
        }).catch((err) => log("error", "magic-link send failed", { err: err?.message }))
      } else {
        log("info", "magic-link issued (no email provider configured)", { email, link })
      }
      return c.json({ ok: true })
    })

    app.get("/auth/email/verify", async (c) => {
      const token = c.req.query("token") ?? ""
      if (!token) return c.text("missing token", 400)
      const row = db.prepare("SELECT email, expiresAt, usedAt FROM _pond_magic_links WHERE token = ?").get(token) as
        | { email: string; expiresAt: string; usedAt: string | null }
        | undefined
      if (!row) return c.text("invalid token", 400)
      if (row.usedAt) return c.text("token already used", 400)
      if (Date.parse(row.expiresAt) < Date.now()) return c.text("token expired", 400)
      db.prepare("UPDATE _pond_magic_links SET usedAt = datetime('now') WHERE token = ?").run(token)
      const userId = `email:${row.email}`
      upsertUser({ id: userId, email: row.email, displayName: row.email.split("@")[0] })
      const session = await signSession({ userId, email: row.email, displayName: row.email.split("@")[0] })
      setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 7 })
      return c.redirect("/", 302)
    })

    app.get("/auth/me", async (c) => {
      return c.json(await resolveAuth(c.req.raw.headers.get("cookie")))
    })

    app.post("/auth/signout", async (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: "/" })
      return c.json({ ok: true })
    })

    // ── Capsule queries / mutations / endpoints wrapped with metrics + rate-limit
    function wrap<T>(routeKey: string, fn: () => Promise<T>): Promise<T> {
      const m = metrics.get(routeKey) ?? createMetric()
      metrics.set(routeKey, m)
      const t0 = Date.now()
      return fn().then(
        (r) => {
          recordMetric(m, Date.now() - t0, false)
          return r
        },
        (err) => {
          recordMetric(m, Date.now() - t0, true)
          throw err
        },
      )
    }

    function rateKey(
      c: { req: { header: (n: string) => string | undefined; raw: { headers: Headers } } },
      by: "ip" | "user" | undefined,
    ): string {
      if (by === "user") {
        const cookie = c.req.raw.headers.get("cookie") ?? ""
        const token = readCookieValue(cookie, SESSION_COOKIE) ?? "anon"
        return token.slice(0, 32)
      }
      // Only trust forwarded headers when the capsule opts in via TRUST_PROXY=1
      // in .env.pond.server — a client can spoof X-Forwarded-For and rotate
      // past the limit otherwise.
      if (env.TRUST_PROXY === "1") {
        return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown"
      }
      return "unknown"
    }

    function enforceRateLimit(c: any, routeName: string): Response | null {
      const limit = def.rateLimit?.[routeName]
      if (!limit) return null
      const key = rateKey(c, limit.by)
      const verdict = rateAllow(routeName, key, limit.perMinute, limit.perHour)
      if (!verdict.ok) {
        return new Response(JSON.stringify({ error: "Rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": String(verdict.retryAfterSeconds) },
        })
      }
      return null
    }

    for (const [name, handler] of Object.entries(def.queries)) {
      app.get(`/api/query/${name}`, async (c) => {
        const denied = enforceRateLimit(c, name)
        if (denied) return denied
        return wrap(`query:${name}`, async () => {
          const ctx = await buildContext(c.req.raw.headers.get("cookie"))
          const result = await (handler as any)(ctx)
          return c.json(result)
        })
      })
      app.post(`/api/query/${name}`, async (c) => {
        const denied = enforceRateLimit(c, name)
        if (denied) return denied
        return wrap(`query:${name}`, async () => {
          const ctx = await buildContext(c.req.raw.headers.get("cookie"))
          const body = (await c.req.json().catch(() => ({}))) as { args?: unknown }
          const args = Array.isArray(body.args) ? body.args : []
          const result = await (handler as any)(ctx, ...args)
          return c.json(result)
        })
      })
    }

    for (const [name, handler] of Object.entries(def.mutations)) {
      app.post(`/api/mutation/${name}`, async (c) => {
        const denied = enforceRateLimit(c, name)
        if (denied) return denied
        return wrap(`mutation:${name}`, async () => {
          const ctx = await buildContext(c.req.raw.headers.get("cookie"))
          const body = await c.req.json()
          const args = body.args ?? []
          const result = await handler(ctx, ...args)
          return c.json(result)
        })
      })
    }

    for (const [name, handler] of Object.entries(def.endpoints ?? {})) {
      const ep = handler as any
      const method = ep._method?.toLowerCase() ?? "get"
      // A bad method would otherwise crash mount with `app[method] is not a
      // function` and no clue which endpoint declared it.
      const ENDPOINT_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options"])
      if (!ENDPOINT_METHODS.has(method)) {
        throw new Error(
          `endpoint "${name}" declares unsupported method "${ep._method}" (allowed: get|post|put|delete|patch|head|options)`,
        )
      }
      const epPath = ep._path ?? `/api/${name}`

      app[method as "get" | "post"](epPath, async (c) => {
        const denied = enforceRateLimit(c, name)
        if (denied) return denied
        return wrap(`endpoint:${name}`, async () => {
          const ctx = await buildContext(c.req.raw.headers.get("cookie"))
          const result = await ep.handler(ctx, {
            headers: c.req.raw.headers,
            query: c.req.query(),
            json: async <T>() => (await c.req.json()) as T,
            text: async () => await c.req.text(),
            bytes: async () => await c.req.arrayBuffer(),
          })
          return c.newResponse(result.body, result.status, result.headers)
        })
      })
    }

    // Blob fetch by key — public read; restrict by writing your own endpoint
    // if you need access control. Keys with "../" or "/" prefixes are rejected.
    app.get("/api/blob/:key{.+}", async (c) => {
      const key = c.req.param("key")
      const got = await blob.get(key)
      if (!got) return c.json({ error: "Not found" }, 404)
      return new Response(got.bytes as any, { status: 200, headers: { "content-type": got.contentType } })
    })

    app.get("/__pond/metrics", (c) => {
      return new Response(renderPrometheus(metrics), {
        status: 200,
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      })
    })
  }

  return {
    mount,
    db,
    def,
    env,
    buildContext,
    // Release the runtime's resources (SQLite handle, sweep timer). The dev
    // server calls this on every rebuild so a hot-reload loop doesn't leak a
    // file descriptor per iteration.
    close: () => {
      clearInterval(rateSweepTimer)
      try {
        db.close()
      } catch {
        // already closed
      }
    },
  }
}

export async function buildForDeploy(
  serverFile: string,
  cwd: string,
  outfileOverride?: string,
): Promise<{ outfile: string; hash: string }> {
  const outfile = outfileOverride ?? path.join(cwd, ".pond", "deploy-bundle.mjs")
  fs.mkdirSync(path.dirname(outfile), { recursive: true })

  const esbuild = await import("esbuild")
  // confineImportsTo: for hosted deploys the source tree is tenant-controlled,
  // so relative imports must not escape the project root (see the plugin docs).
  // The entry itself is realpath-checked because esbuild reads it through
  // symlinks — a planted symlink must not feed host files into the bundle.
  if (!containedRealPath(cwd, serverFile)) {
    throw new Error("server entry must resolve inside the project directory")
  }
  await esbuild.build({
    entryPoints: [serverFile],
    bundle: true,
    write: true,
    outfile,
    format: "esm",
    target: "es2020",
    platform: "node",
    minify: true,
    sourcemap: false,
    external: ["better-sqlite3"],
    alias: {
      "pond/server": path.resolve(import.meta.dirname, "../src/server/index.ts"),
    },
    plugins: [confineImportsTo(cwd)],
  })

  const hash = createHash("sha256").update(fs.readFileSync(outfile)).digest("hex")
  return { outfile, hash }
}

function assertIdent(name: string) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`)
  }
  if (name.length > 64) {
    throw new Error(`Identifier too long (max 64 chars): ${name}`)
  }
  if (name.startsWith("_pond_")) {
    throw new Error(`Identifier "${name}" uses reserved _pond_ prefix`)
  }
}

// Validate an identifier's shape, then double-quote it for safe use in SQL.
// Quoting lets SQLite reserved words (e.g. "key", "order") be used as table or
// column names. assertIdent already restricts names to [A-Za-z0-9_], so there
// are no embedded quotes to escape and no injection risk.
function quoteIdent(name: string): string {
  assertIdent(name)
  return `"${name}"`
}

// better-sqlite3 rejects boolean values with "SQLite3 can only bind numbers, strings,
// bigints, buffers, and null". Capsule schemas declare `boolean()` columns and agents
// naturally pass `true`/`false` — coerce to 1/0 at the binding boundary.
function coerceBinding(value: any): any {
  if (typeof value === "boolean") return value ? 1 : 0
  return value
}

// Runtime type-check a value about to be bound to a declared column. Handler
// param types are TypeScript-only and fully erased in the bundled worker, so an
// agent calling `add(ctx, "foo")` where a `number()` column was declared reaches
// the DB with a string. SQLite is dynamically typed and would store it silently;
// we reject it here so the column's declared type is actually enforced at the
// untrusted-input boundary. Derived entirely from the schema's `_sqlType` (no
// Zod, per the capsule spec). NULL/undefined pass — columns are nullable.
function assertColumnValue(tableName: string, column: string, sqlType: string, value: any): void {
  if (value === null || value === undefined) return
  if (sqlType === "TEXT") {
    if (typeof value !== "string") {
      throw new Error(`Column "${tableName}.${column}" expects a string (TEXT), got ${typeof value}`)
    }
  } else if (sqlType === "REAL") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Column "${tableName}.${column}" expects a finite number (REAL), got ${typeof value}`)
    }
  } else if (sqlType === "INTEGER") {
    // boolean() columns compile to INTEGER and agents pass true/false (coerced
    // to 1/0 at binding), so both number and boolean are valid here.
    if (typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Column "${tableName}.${column}" expects a number or boolean (INTEGER), got ${typeof value}`)
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Column "${tableName}.${column}" expects a finite number (INTEGER), got ${value}`)
    }
  }
  // Unknown sqlType: forward-compatible no-op.
}

function buildDbProxy(db: Database.Database, schema: Record<string, Record<string, ColumnType>>): CapsuleContext["db"] {
  // Validate every supplied value that maps to a declared column. Keys not in
  // the schema (reserved id/createdAt/updatedAt, or typos) are left to SQLite,
  // which accepts the reserved ones and rejects unknown columns as it does today.
  function validateColumns(tableName: string, data: Record<string, any>): void {
    const cols = schema[tableName]
    if (!cols) return
    for (const key of Object.keys(data)) {
      const colType = cols[key]
      if (colType) assertColumnValue(tableName, key, colType._sqlType, data[key])
    }
  }
  // limit/offset are interpolated into SQL (they can't be bound parameters in a
  // prepared LIMIT clause), so they must be proven safe non-negative integers —
  // values reach here from capsule handler args (untrusted) in the hosted model.
  function assertPageArg(kind: "limit" | "offset", n: number): number {
    if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${kind}: ${n} (expected a non-negative integer)`)
    return n
  }

  function createBuilder(
    tableName: string,
    parts: {
      where: Array<{ column: string; value: any }>
      orderBy: Array<{ column: string; dir: "asc" | "desc" }>
      limit?: number
      offset?: number
    },
  ) {
    const whereClause = () => ({
      sql:
        parts.where.length > 0
          ? ` WHERE ${parts.where.map(({ column }) => `${quoteIdent(column)} = ?`).join(" AND ")}`
          : "",
      values: parts.where.map(({ value }) => value),
    })
    return {
      where(column: string, value: any) {
        assertIdent(column)
        return createBuilder(tableName, {
          ...parts,
          where: [...parts.where, { column, value }],
        })
      },
      orderBy(column: string, dir: "asc" | "desc") {
        assertIdent(column)
        if (dir !== "asc" && dir !== "desc") throw new Error(`Invalid order direction: ${dir}`)
        return createBuilder(tableName, {
          ...parts,
          orderBy: [...parts.orderBy, { column, dir }],
        })
      },
      limit(limit: number) {
        return createBuilder(tableName, {
          ...parts,
          limit: assertPageArg("limit", limit),
        })
      },
      offset(offset: number) {
        return createBuilder(tableName, {
          ...parts,
          offset: assertPageArg("offset", offset),
        })
      },
      all() {
        const { sql: whereSql, values } = whereClause()
        const orderSql =
          parts.orderBy.length > 0
            ? ` ORDER BY ${parts.orderBy.map(({ column, dir }) => `${quoteIdent(column)} ${dir.toUpperCase()}`).join(", ")}`
            : ""
        // SQLite requires a LIMIT before an OFFSET; `LIMIT -1` means "no limit".
        const hasLimit = typeof parts.limit === "number"
        const hasOffset = typeof parts.offset === "number"
        const pageSql = hasOffset
          ? ` LIMIT ${hasLimit ? parts.limit : -1} OFFSET ${parts.offset}`
          : hasLimit
            ? ` LIMIT ${parts.limit}`
            : ""
        return db.prepare(`SELECT * FROM ${quoteIdent(tableName)}${whereSql}${orderSql}${pageSql}`).all(...values)
      },
      count(): number {
        const { sql: whereSql, values } = whereClause()
        const row = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(tableName)}${whereSql}`).get(...values) as {
          c: number
        }
        return row.c
      },
    }
  }

  return new Proxy({} as any, {
    get(_target, tableName: string) {
      assertIdent(tableName)
      const builder = createBuilder(tableName, { where: [], orderBy: [] })
      return {
        where: builder.where,
        orderBy: builder.orderBy,
        limit: builder.limit,
        offset: builder.offset,
        all: builder.all,
        count: builder.count,
        get(id: string) {
          return db.prepare(`SELECT * FROM ${quoteIdent(tableName)} WHERE id = ?`).get(id)
        },
        insert(data: Record<string, any>) {
          validateColumns(tableName, data)
          const id = crypto.randomUUID()
          const keys = Object.keys(data)
          const cols = keys.map(quoteIdent)
          const values = keys.map((key) => coerceBinding(data[key]))
          // Empty data must still produce valid SQL (`(id, ) VALUES (?, )` is
          // a syntax error) — insert just the row id + timestamps.
          const colSql = keys.length > 0 ? `, ${cols.join(", ")}` : ""
          const valSql = keys.length > 0 ? `, ${keys.map(() => "?").join(", ")}` : ""
          db.prepare(`INSERT INTO ${quoteIdent(tableName)} (id${colSql}) VALUES (?${valSql})`).run(id, ...values)
          return db.prepare(`SELECT * FROM ${quoteIdent(tableName)} WHERE id = ?`).get(id)
        },
        update(id: string, data: Record<string, any>) {
          validateColumns(tableName, data)
          const keys = Object.keys(data)
          if (keys.length === 0) {
            // Empty set — a no-op that succeeds (nothing to change).
            return db.prepare(`SELECT * FROM ${quoteIdent(tableName)} WHERE id = ?`).get(id)
          }
          const sets = keys.map((key) => `${quoteIdent(key)} = ?`).join(", ")
          db.prepare(`UPDATE ${quoteIdent(tableName)} SET ${sets}, updatedAt = datetime('now') WHERE id = ?`).run(
            ...keys.map((key) => coerceBinding(data[key])),
            id,
          )
          return db.prepare(`SELECT * FROM ${quoteIdent(tableName)} WHERE id = ?`).get(id)
        },
        delete(id: string) {
          db.prepare(`DELETE FROM ${quoteIdent(tableName)} WHERE id = ?`).run(id)
        },
      }
    },
  })
}

function loadEnv(cwd: string, port: number): Record<string, string> {
  const env: Record<string, string> = {}
  const envFile = path.join(cwd, ".env.pond.server")
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
    }
  }
  if (!env.GOOGLE_REDIRECT_URI) {
    env.GOOGLE_REDIRECT_URI = `http://localhost:${port}/auth/google/callback`
  }
  return env
}

function readCookieValue(cookieHeader: string, name: string): string | undefined {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}
