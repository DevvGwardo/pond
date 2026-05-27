import { Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import Database from "better-sqlite3"
import * as esbuild from "esbuild"
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { pathToFileURL } from "node:url"
import { Google, generateCodeVerifier, generateState } from "arctic"
import { SignJWT, jwtVerify } from "jose"
import { CapsuleAuth, CapsuleContext, CapsuleDefinition } from "./server/index.js"

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

export async function createRuntime(
  serverFile: string,
  cwd: string,
  options: RuntimeOptions = {},
): Promise<{ mount: (app: Hono) => void; db: Database.Database; def: CapsuleDefinition; env: Record<string, string> }> {
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
): Promise<{ mount: (app: Hono) => void; db: Database.Database; def: CapsuleDefinition; env: Record<string, string> }> {
  const mod: ServerModule = await import(`${pathToFileURL(bundleFile).href}?t=${Date.now()}`)
  return createRuntimeFromDefinition(mod.default, cwd, options)
}

function createRuntimeFromDefinition(
  def: CapsuleDefinition,
  cwd: string,
  options: RuntimeOptions = {},
): { mount: (app: Hono) => void; db: Database.Database; def: CapsuleDefinition; env: Record<string, string> } {
  const dbPath = path.join(cwd, ".pond", "data.db")
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.exec("CREATE TABLE IF NOT EXISTS _pond_migrations (name TEXT PRIMARY KEY)")
  db.exec(
    "CREATE TABLE IF NOT EXISTS _pond_users (id TEXT PRIMARY KEY, googleId TEXT UNIQUE, displayName TEXT, picture TEXT, email TEXT, createdAt TEXT DEFAULT (datetime('now')), updatedAt TEXT DEFAULT (datetime('now')))",
  )

  for (const [tableName, columns] of Object.entries(def.schema)) {
    assertIdent(tableName)
    const exists = db.prepare("SELECT name FROM _pond_migrations WHERE name = ?").get(`table_${tableName}`)

    if (!exists) {
      const colDefs = Object.entries(columns).map(([col, type]) => {
        assertIdent(col)
        return `${col} ${type._sqlType}`
      })
      colDefs.push("id TEXT PRIMARY KEY")
      colDefs.push("createdAt TEXT DEFAULT (datetime('now'))")
      colDefs.push("updatedAt TEXT DEFAULT (datetime('now'))")

      db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs.join(", ")})`)
      db.prepare("INSERT INTO _pond_migrations (name) VALUES (?)").run(`table_${tableName}`)
    }
  }

  const env = loadEnv(cwd, options.port ?? 3000)
  const dbProxy = buildDbProxy(db)
  let sessionSecretSource = env.POND_SESSION_SECRET || env.GOOGLE_CLIENT_SECRET
  if (!sessionSecretSource) {
    sessionSecretSource = randomBytes(32).toString("hex")
    console.warn(
      "[pond] WARNING: no POND_SESSION_SECRET set — generated an ephemeral secret. Sessions will not survive restart. Set POND_SESSION_SECRET in .env.pond.server for production.",
    )
  }
  const sessionSecret = new TextEncoder().encode(sessionSecretSource)
  const guestAuth = options.getGuestAuth ?? (() => ({ isGuest: true, userId: "guest", displayName: "Guest" }))
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI
      ? new Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI)
      : null

  const log = (level: "info" | "error", message: string, data?: any) => {
    const entry = { timestamp: new Date().toISOString(), level, message, data }
    options.onLog?.(entry)
    if (level === "info") {
      console.log(`[pond] ${message}`, data ?? "")
    } else {
      console.error(`[pond] ${message}`, data ?? "")
    }
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
      auth: await resolveAuth(cookieHeader),
      env,
      log: {
        info: (message: string, data?: any) => log("info", message, data),
        error: (message: string, data?: any) => log("error", message, data),
      },
    }
  }

  function mount(app: Hono) {
    // Tiny inline favicon — a teal water droplet on the same dark background
    // as the default client shell. Without this, every deployed capsule
    // returns 404 for /favicon.ico, which is noisy and looks broken.
    const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#09090b"/><path d="M16 6c-3 5-7 9-7 13a7 7 0 0 0 14 0c0-4-4-8-7-13z" fill="#67e8f9"/></svg>`
    app.get(
      "/favicon.svg",
      (c) =>
        new Response(FAVICON_SVG, {
          status: 200,
          headers: {
            "content-type": "image/svg+xml",
            "cache-control": "public, max-age=86400",
          },
        }),
    )
    app.get(
      "/favicon.ico",
      (c) =>
        new Response(FAVICON_SVG, {
          status: 200,
          headers: {
            "content-type": "image/svg+xml",
            "cache-control": "public, max-age=86400",
          },
        }),
    )

    app.get("/auth/google", async (c) => {
      if (!google) return c.text("Missing Google OAuth configuration", 500)

      const state = generateState()
      const codeVerifier = generateCodeVerifier()
      const url = google.createAuthorizationURL(state, codeVerifier, ["openid", "profile", "email"])

      setCookie(c, OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 600,
      })
      setCookie(c, OAUTH_VERIFIER_COOKIE, codeVerifier, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 600,
      })

      return c.redirect(url.toString(), 302)
    })

    app.get("/auth/google/callback", async (c) => {
      if (!google) return c.text("Missing Google OAuth configuration", 500)

      const code = c.req.query("code")
      const state = c.req.query("state")
      const storedState = getCookie(c, OAUTH_STATE_COOKIE)
      const codeVerifier = getCookie(c, OAUTH_VERIFIER_COOKIE)

      if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
        return c.text("Invalid OAuth callback", 400)
      }

      const tokens = await google.validateAuthorizationCode(code, codeVerifier)
      const userInfoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: {
          authorization: `Bearer ${tokens.accessToken()}`,
        },
      })

      if (!userInfoRes.ok) {
        return c.text("Failed to fetch Google user info", 500)
      }

      const userInfo = (await userInfoRes.json()) as {
        sub: string
        name?: string
        picture?: string
        email?: string
      }

      db.prepare(
        "INSERT INTO _pond_users (id, googleId, displayName, picture, email) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET googleId = excluded.googleId, displayName = excluded.displayName, picture = excluded.picture, email = excluded.email, updatedAt = datetime('now')",
      ).run(userInfo.sub, userInfo.sub, userInfo.name ?? null, userInfo.picture ?? null, userInfo.email ?? null)

      const session = await new SignJWT({
        userId: userInfo.sub,
        displayName: userInfo.name,
        picture: userInfo.picture,
        email: userInfo.email,
      } satisfies SessionPayload)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(sessionSecret)

      setCookie(c, SESSION_COOKIE, session, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      })
      deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" })
      deleteCookie(c, OAUTH_VERIFIER_COOKIE, { path: "/" })

      return c.redirect("/", 302)
    })

    app.get("/auth/me", async (c) => {
      return c.json(await resolveAuth(c.req.raw.headers.get("cookie")))
    })

    app.post("/auth/signout", async (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: "/" })
      return c.json({ ok: true })
    })

    for (const [name, handler] of Object.entries(def.queries)) {
      app.get(`/api/query/${name}`, async (c) => {
        const ctx = await buildContext(c.req.raw.headers.get("cookie"))
        const result = await handler(ctx)
        return c.json(result)
      })
    }

    for (const [name, handler] of Object.entries(def.mutations)) {
      app.post(`/api/mutation/${name}`, async (c) => {
        const ctx = await buildContext(c.req.raw.headers.get("cookie"))
        const body = await c.req.json()
        const args = body.args ?? []
        const result = await handler(ctx, ...args)
        return c.json(result)
      })
    }

    for (const [name, handler] of Object.entries(def.endpoints ?? {})) {
      const ep = handler as any
      const method = ep._method?.toLowerCase() ?? "get"
      const epPath = ep._path ?? `/api/${name}`

      app[method as "get" | "post"](epPath, async (c) => {
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
    }
  }

  return { mount, db, def, env }
}

export async function buildForDeploy(serverFile: string, cwd: string): Promise<{ outfile: string; hash: string }> {
  const outfile = path.join(cwd, ".pond", "deploy-bundle.mjs")
  fs.mkdirSync(path.dirname(outfile), { recursive: true })

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
  })

  const hash = createHash("sha256").update(fs.readFileSync(outfile)).digest("hex")
  return { outfile, hash }
}

// SQLite reserved words — using any of these unquoted as a table/column name
// produces a syntax error at the next CREATE/SELECT. List from sqlite.org/lang_keywords.html.
const SQLITE_RESERVED_WORDS = new Set([
  "ABORT",
  "ACTION",
  "ADD",
  "AFTER",
  "ALL",
  "ALTER",
  "ANALYZE",
  "AND",
  "AS",
  "ASC",
  "ATTACH",
  "AUTOINCREMENT",
  "BEFORE",
  "BEGIN",
  "BETWEEN",
  "BY",
  "CASCADE",
  "CASE",
  "CAST",
  "CHECK",
  "COLLATE",
  "COLUMN",
  "COMMIT",
  "CONFLICT",
  "CONSTRAINT",
  "CREATE",
  "CROSS",
  "CURRENT",
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "DATABASE",
  "DEFAULT",
  "DEFERRABLE",
  "DEFERRED",
  "DELETE",
  "DESC",
  "DETACH",
  "DISTINCT",
  "DO",
  "DROP",
  "EACH",
  "ELSE",
  "END",
  "ESCAPE",
  "EXCEPT",
  "EXCLUDE",
  "EXCLUSIVE",
  "EXISTS",
  "EXPLAIN",
  "FAIL",
  "FILTER",
  "FIRST",
  "FOLLOWING",
  "FOR",
  "FOREIGN",
  "FROM",
  "FULL",
  "GENERATED",
  "GLOB",
  "GROUP",
  "GROUPS",
  "HAVING",
  "IF",
  "IGNORE",
  "IMMEDIATE",
  "IN",
  "INDEX",
  "INDEXED",
  "INITIALLY",
  "INNER",
  "INSERT",
  "INSTEAD",
  "INTERSECT",
  "INTO",
  "IS",
  "ISNULL",
  "JOIN",
  "KEY",
  "LAST",
  "LEFT",
  "LIKE",
  "LIMIT",
  "MATCH",
  "NATURAL",
  "NO",
  "NOT",
  "NOTHING",
  "NOTNULL",
  "NULL",
  "NULLS",
  "OF",
  "OFFSET",
  "ON",
  "OR",
  "ORDER",
  "OTHERS",
  "OUTER",
  "OVER",
  "PARTITION",
  "PLAN",
  "PRAGMA",
  "PRECEDING",
  "PRIMARY",
  "QUERY",
  "RAISE",
  "RANGE",
  "RECURSIVE",
  "REFERENCES",
  "REGEXP",
  "REINDEX",
  "RELEASE",
  "RENAME",
  "REPLACE",
  "RESTRICT",
  "RIGHT",
  "ROLLBACK",
  "ROW",
  "ROWS",
  "SAVEPOINT",
  "SELECT",
  "SET",
  "TABLE",
  "TEMP",
  "TEMPORARY",
  "THEN",
  "TIES",
  "TO",
  "TRANSACTION",
  "TRIGGER",
  "UNBOUNDED",
  "UNION",
  "UNIQUE",
  "UPDATE",
  "USING",
  "VACUUM",
  "VALUES",
  "VIEW",
  "VIRTUAL",
  "WHEN",
  "WHERE",
  "WINDOW",
  "WITH",
  "WITHOUT",
])

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
  if (SQLITE_RESERVED_WORDS.has(name.toUpperCase())) {
    throw new Error(`Identifier "${name}" is a SQLite reserved word`)
  }
}

function buildDbProxy(db: Database.Database): CapsuleContext["db"] {
  function createBuilder(
    tableName: string,
    parts: {
      where: Array<{ column: string; value: any }>
      orderBy: Array<{ column: string; dir: "asc" | "desc" }>
      limit?: number
    },
  ) {
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
          limit,
        })
      },
      all() {
        const whereSql =
          parts.where.length > 0 ? ` WHERE ${parts.where.map(({ column }) => `${column} = ?`).join(" AND ")}` : ""
        const orderSql =
          parts.orderBy.length > 0
            ? ` ORDER BY ${parts.orderBy.map(({ column, dir }) => `${column} ${dir.toUpperCase()}`).join(", ")}`
            : ""
        const limitSql = typeof parts.limit === "number" ? ` LIMIT ${parts.limit}` : ""
        return db
          .prepare(`SELECT * FROM ${tableName}${whereSql}${orderSql}${limitSql}`)
          .all(...parts.where.map(({ value }) => value))
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
        all: builder.all,
        get(id: string) {
          return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id)
        },
        insert(data: Record<string, any>) {
          const id = crypto.randomUUID()
          const keys = Object.keys(data)
          keys.forEach(assertIdent)
          const values = keys.map((key) => data[key])
          db.prepare(
            `INSERT INTO ${tableName} (id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
          ).run(id, ...values)
          return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id)
        },
        update(id: string, data: Record<string, any>) {
          const keys = Object.keys(data)
          keys.forEach(assertIdent)
          const sets = keys.map((key) => `${key} = ?`).join(", ")
          db.prepare(`UPDATE ${tableName} SET ${sets}, updatedAt = datetime('now') WHERE id = ?`).run(
            ...keys.map((key) => data[key]),
            id,
          )
          return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id)
        },
        delete(id: string) {
          db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id)
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
