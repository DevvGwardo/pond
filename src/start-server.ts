import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { WebSocketServer, type WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import type { Socket as NetSocket } from "node:net"
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, timingSafeEqual } from "node:crypto"
import { createRuntimeFromDeployBundle } from "./runtime.js"
import { validateSqliteFile } from "./host/control-db.js"
import type { SocketHandler, SocketLike } from "./server/index.js"

interface StartBundleServerOptions {
  bundlePath: string
  clientPath?: string
  cwd: string
  port: number
  hostname?: string
  // sha256 hex of the claim token. Compared timing-safe with the hash of
  // the incoming x-pond-claim-token header. Plaintext is never stored.
  inspectSecretHash?: string
  publicInspect?: boolean
  allowedOrigins?: string[]
  // Upper bound (bytes) on a /__pond/db/restore upload, derived from the
  // deploy's disk quota. Caps the in-memory buffer so a restore can't be used
  // to fill the disk or balloon the worker. 0/undefined falls back to a default.
  maxRestoreBytes?: number
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

interface LogEntry {
  timestamp: string
  level: "info" | "error"
  message: string
  data?: any
}

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024
const RECENT_LOG_CAP = 200

function hostFromHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  return hostHeader.toLowerCase().trim()
}

function originHost(originHeader: string): string | null {
  try {
    const u = new URL(originHeader)
    return u.host.toLowerCase()
  } catch {
    return null
  }
}

function corsHeadersFor(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: string[],
): Record<string, string> {
  if (!origin) return {}
  const oHost = originHost(origin)
  if (!oHost) return {}
  const hostNorm = host ? host.toLowerCase() : ""
  const allowedSet = new Set(allowedOrigins.map((o) => o.toLowerCase().replace(/\/$/, "")))
  const originNorm = origin.toLowerCase().replace(/\/$/, "")
  const sameOrigin = hostNorm && oHost === hostNorm
  if (!sameOrigin && !allowedSet.has(originNorm)) return {}
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, authorization, x-pond-claim-token",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  }
}

function readRecentLogsFromDisk(logFile: string, cap: number): LogEntry[] {
  if (!fs.existsSync(logFile)) return []
  try {
    const text = fs.readFileSync(logFile, "utf-8")
    const lines = text.split("\n").filter((l) => l.length > 0)
    const start = Math.max(0, lines.length - cap)
    const out: LogEntry[] = []
    for (let i = start; i < lines.length; i++) {
      try {
        out.push(JSON.parse(lines[i]) as LogEntry)
      } catch {
        // skip malformed
      }
    }
    return out
  } catch {
    return []
  }
}

export async function createBundleServerApp(options: StartBundleServerOptions): Promise<Hono> {
  const { app } = await createBundleServerAppInternal(options)
  return app
}

async function createBundleServerAppInternal(
  options: StartBundleServerOptions,
): Promise<{ app: Hono; runtime: RuntimeShape }> {
  const app = new Hono()
  const encoder = new TextEncoder()
  const logClients = new Set<ReadableStreamDefaultController<Uint8Array>>()

  const logsDir = path.join(options.cwd, ".pond")
  const logFile = path.join(logsDir, "logs.ndjson")
  const logFileRotated = path.join(logsDir, "logs.ndjson.1")
  fs.mkdirSync(logsDir, { recursive: true })

  const recentLogs: LogEntry[] = readRecentLogsFromDisk(logFile, RECENT_LOG_CAP)

  function appendLogToDisk(entry: LogEntry) {
    try {
      const line = JSON.stringify(entry) + "\n"
      let size = 0
      try {
        size = fs.statSync(logFile).size
      } catch {
        size = 0
      }
      if (size + Buffer.byteLength(line) > MAX_LOG_FILE_BYTES) {
        try {
          fs.renameSync(logFile, logFileRotated)
        } catch {
          // best effort
        }
      }
      fs.appendFileSync(logFile, line)
    } catch {
      // best effort
    }
  }

  const runtime = await createRuntimeFromDeployBundle(options.bundlePath, options.cwd, {
    port: options.port,
    onLog: (entry) => {
      recentLogs.push(entry)
      if (recentLogs.length > RECENT_LOG_CAP) recentLogs.shift()
      appendLogToDisk(entry)
      const chunk = encoder.encode(`data: ${JSON.stringify(entry)}\n\n`)
      for (const client of logClients) {
        try {
          client.enqueue(chunk)
        } catch {
          logClients.delete(client)
        }
      }
    },
  })

  const defAllowed = Array.isArray(runtime.def.allowedOrigins) ? runtime.def.allowedOrigins : []
  const optAllowed = Array.isArray(options.allowedOrigins) ? options.allowedOrigins : []
  const allowedOrigins = [...defAllowed, ...optAllowed]

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin")
    const host = hostFromHeader(c.req.header("host"))
    const headers = corsHeadersFor(origin, host ?? undefined, allowedOrigins)
    if (c.req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers })
    }
    await next()
    for (const [k, v] of Object.entries(headers)) {
      c.res.headers.set(k, v)
    }
  })

  if (options.clientPath && fs.existsSync(options.clientPath)) {
    const html = fs.readFileSync(options.clientPath, "utf-8")
    app.get("/", (c) => c.html(html))
  }

  runtime.mount(app)

  // Timing-safe claim-token check. Hashing the incoming header before compare
  // means a backup leak of the host's record JSONs (which contain only the
  // hash) doesn't yield a valid header value, and an equality-timing attack on
  // this code path yields no useful signal. When no inspectSecretHash is
  // configured (local `pond dev`) everything is open for convenience.
  function hasClaimToken(headerToken: string | undefined) {
    if (!options.inspectSecretHash) return true
    if (!headerToken) return false
    const a = Buffer.from(sha256Hex(headerToken))
    const b = Buffer.from(options.inspectSecretHash)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  // Read-only inspection (schema, table list, row dumps). publicInspect opens
  // these to anyone — that's the point of marking a deploy publicly inspectable.
  function canInspect(headerToken: string | undefined) {
    if (options.publicInspect) return true
    return hasClaimToken(headerToken)
  }

  // Privileged operations: full-database backup (bulk exfil), restore (a WRITE
  // to the deploy's data), and log streaming (may contain secrets). These are
  // NOT covered by publicInspect — they always require the claim token, even on
  // a publicly inspectable deploy.
  function canManage(headerToken: string | undefined) {
    return hasClaimToken(headerToken)
  }

  app.get("/__pond/inspect", (c) => {
    if (!canInspect(c.req.header("x-pond-claim-token"))) {
      return c.json({ error: "Forbidden" }, 403)
    }
    return c.json({
      schema: Object.keys(runtime.def.schema),
      queries: Object.keys(runtime.def.queries),
      mutations: Object.keys(runtime.def.mutations),
      endpoints: Object.keys(runtime.def.endpoints ?? {}),
      env: {
        GOOGLE_REDIRECT_URI: runtime.env.GOOGLE_REDIRECT_URI,
      },
    })
  })

  app.get("/__pond/db/tables", (c) => {
    if (!canInspect(c.req.header("x-pond-claim-token"))) {
      return c.json({ error: "Forbidden" }, 403)
    }
    const tables = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
      .all() as Array<{ name: string }>
    return c.json(tables.map((table) => table.name))
  })

  app.get("/__pond/db/dump/:table", (c) => {
    if (!canInspect(c.req.header("x-pond-claim-token"))) {
      return c.json({ error: "Forbidden" }, 403)
    }
    const table = c.req.param("table")
    const exists = runtime.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    if (!exists) return c.json({ error: `Unknown table: ${table}` }, 404)
    return c.json(runtime.db.prepare(`SELECT * FROM ${table}`).all())
  })

  app.get("/__pond/db/backup", (c) => {
    if (!canManage(c.req.header("x-pond-claim-token"))) {
      return c.json({ error: "Forbidden" }, 403)
    }
    // VACUUM INTO produces a clean, consistent SQLite snapshot in one statement
    // without locking the live db. The temp file is deleted after the response
    // body is read out into memory.
    const tmp = path.join(options.cwd, ".pond", `backup-${Date.now()}-${process.pid}.db`)
    try {
      runtime.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
      const buf = fs.readFileSync(tmp)
      return new Response(buf as any, {
        status: 200,
        headers: {
          "content-type": "application/x-sqlite3",
          "content-disposition": `attachment; filename="pond-backup-${new Date().toISOString().slice(0, 10)}.db"`,
        },
      })
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // best effort
      }
    }
  })

  app.post("/__pond/db/restore", async (c) => {
    if (!canManage(c.req.header("x-pond-claim-token"))) {
      return c.json({ error: "Forbidden" }, 403)
    }
    // We deliberately do NOT swap the live db handle here — restoring on a
    // running process is fraught (open WAL, in-flight queries). Instead, write
    // the candidate to .pond/data.db.restored and tell the caller to restart.
    // Bound the upload before buffering it all into memory / onto disk. A
    // content-length over the cap is rejected up front; the actual byte length
    // is re-checked after read in case the header lied.
    const maxRestore =
      options.maxRestoreBytes && options.maxRestoreBytes > 0 ? options.maxRestoreBytes : 256 * 1024 * 1024
    const declaredLen = Number(c.req.header("content-length") ?? "0")
    if (Number.isFinite(declaredLen) && declaredLen > maxRestore) {
      return c.json({ error: `restore exceeds limit (${maxRestore} bytes)` }, 413)
    }
    const body = await c.req.arrayBuffer()
    if (body.byteLength > maxRestore) return c.json({ error: `restore exceeds limit (${maxRestore} bytes)` }, 413)
    if (body.byteLength < 16) return c.json({ error: "bundle too small" }, 400)
    // Lightweight SQLite header check
    const header = Buffer.from(body).slice(0, 16).toString("utf-8")
    if (!header.startsWith("SQLite format 3")) return c.json({ error: "not a SQLite db file" }, 400)
    const dst = path.join(options.cwd, ".pond", "data.db")
    const staging = path.join(options.cwd, ".pond", "data.db.restored")
    fs.writeFileSync(staging, Buffer.from(body))
    // The 16-byte magic check above only proves the upload starts like a SQLite
    // file; a truncated or corrupt body sails past it and would brick the worker
    // on next boot when it opens data.db. Prove the candidate is actually a
    // queryable database BEFORE we stage it for the operator's swap. On failure
    // the staging file is removed so a broken candidate is never left for swap.
    const valid = validateSqliteFile(staging)
    if (!valid.ok) {
      try {
        fs.unlinkSync(staging)
      } catch {
        // best effort
      }
      return c.json({ error: `restore candidate is not a usable SQLite database: ${valid.error}` }, 400)
    }
    return c.json({
      ok: true,
      message: `Wrote ${body.byteLength} bytes to ${staging} (validated: integrity_check ok). Stop the server, atomically replace ${dst}, then restart.`,
      staging,
      target: dst,
    })
  })

  // Destructive schema migration. The auto-migrator (applyMigrations) adds new
  // columns but REFUSES to drop one, since a removed column in server/index.ts is
  // far more likely a typo than an intentional data deletion. This endpoint is
  // the explicit, owner-authorized escape hatch the boot error points at: drop or
  // rename a column on the live data.db so the next deploy's schema diff is clean.
  // Manage-gated (owner only) and confined to the capsule's own database.
  app.post("/__pond/db/migrate", async (c) => {
    if (!canManage(c.req.header("x-pond-claim-token"))) {
      return c.json({ error: "Forbidden" }, 403)
    }
    const body = (await c.req.json().catch(() => null)) as {
      op?: string
      table?: string
      column?: string
      to?: string
    } | null
    if (!body || typeof body.op !== "string") return c.json({ error: "missing op" }, 400)

    const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
    const RESERVED = new Set(["id", "createdAt", "updatedAt"])
    // Validate an identifier (same rules as the runtime's assertIdent) and quote
    // it. The regex admits no quote characters, so interpolation is injection-safe.
    const ident = (
      name: unknown,
      what: string,
    ): { ok: true; q: string; raw: string } | { ok: false; error: string } => {
      if (typeof name !== "string" || !IDENT.test(name) || name.length > 64)
        return { ok: false, error: `invalid ${what}` }
      if (name.startsWith("_pond_")) return { ok: false, error: `${what} uses the reserved _pond_ prefix` }
      return { ok: true, q: `"${name}"`, raw: name }
    }

    const t = ident(body.table, "table")
    if (!t.ok) return c.json({ error: t.error }, 400)
    const col = ident(body.column, "column")
    if (!col.ok) return c.json({ error: col.error }, 400)

    const tableExists = runtime.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t.raw)
    if (!tableExists) return c.json({ error: `unknown table: ${t.raw}` }, 404)
    const cols = (runtime.db.prepare(`PRAGMA table_info(${t.q})`).all() as Array<{ name: string }>).map((r) => r.name)
    if (!cols.includes(col.raw)) return c.json({ error: `unknown column: ${t.raw}.${col.raw}` }, 404)
    if (RESERVED.has(col.raw)) return c.json({ error: `cannot ${body.op} reserved column ${col.raw}` }, 400)

    try {
      if (body.op === "drop") {
        runtime.db.prepare(`ALTER TABLE ${t.q} DROP COLUMN ${col.q}`).run()
        return c.json({ ok: true, message: `Dropped column ${t.raw}.${col.raw}` })
      }
      if (body.op === "rename") {
        const to = ident(body.to, "new column name")
        if (!to.ok) return c.json({ error: to.error }, 400)
        if (cols.includes(to.raw)) return c.json({ error: `column ${t.raw}.${to.raw} already exists` }, 409)
        runtime.db.prepare(`ALTER TABLE ${t.q} RENAME COLUMN ${col.q} TO ${to.q}`).run()
        return c.json({ ok: true, message: `Renamed column ${t.raw}.${col.raw} → ${to.raw}` })
      }
      return c.json({ error: `unknown op: ${body.op} (expected drop|rename)` }, 400)
    } catch (err: any) {
      return c.json({ error: `migration failed: ${err?.message ?? String(err)}` }, 400)
    }
  })

  app.get("/__pond/logs", (c) => {
    if (!canManage(c.req.header("x-pond-claim-token"))) {
      return c.json({ error: "Forbidden" }, 403)
    }
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    return new Response(
      new ReadableStream({
        start(controller) {
          streamController = controller
          logClients.add(controller)
          const replay =
            recentLogs.length < RECENT_LOG_CAP ? readRecentLogsFromDisk(logFile, RECENT_LOG_CAP) : recentLogs
          for (const entry of replay) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`))
          }
        },
        cancel() {
          if (streamController) {
            logClients.delete(streamController)
          }
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      },
    )
  })

  return { app, runtime: runtime as unknown as RuntimeShape }
}

export async function serveBundleServer(options: StartBundleServerOptions) {
  const built = await createBundleServerAppInternal(options)
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve, reject) => {
    const s = serve({ fetch: built.app.fetch, port: options.port, hostname: options.hostname }, (info) => {
      resolve({ server: s, port: info.port })
    })
    s.once("error", reject)
  })
  attachSocketUpgrade(server, built.runtime)
  return { app: built.app, server, port }
}

interface RuntimeShape {
  def: { sockets?: Record<string, { _kind: "socket"; handler: SocketHandler }> }
  buildContext: (cookieHeader: string | null | undefined) => Promise<unknown>
}

// Hooks WebSocket upgrade requests to the named handlers declared on the
// capsule definition. Each upgrade request is matched against the path
// /api/socket/<name>; mismatched paths are rejected with HTTP 404.
function attachSocketUpgrade(server: { on: (ev: string, fn: (...a: any[]) => void) => void }, runtime: RuntimeShape) {
  const sockets = runtime.def.sockets ?? {}
  if (Object.keys(sockets).length === 0) return
  const wss = new WebSocketServer({ noServer: true })

  server.on("upgrade", (req: IncomingMessage, socket: NetSocket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const match = url.pathname.match(/^\/api\/socket\/([a-zA-Z_][a-zA-Z0-9_]*)$/)
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
      socket.destroy()
      return
    }
    const name = match[1]
    const def = sockets[name]
    if (!def) {
      socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        const ctx = await runtime.buildContext(req.headers.cookie ?? null)
        const wrapped = wrapWebSocket(ws)
        await def.handler(ctx as any, wrapped)
      } catch (err) {
        // Surface the failure to the client with a clean close.
        try {
          ws.close(1011, err instanceof Error ? err.message.slice(0, 120) : "handler error")
        } catch {
          // best effort
        }
      }
    })
  })
}

function wrapWebSocket(ws: WebSocket): SocketLike {
  return {
    send(data) {
      try {
        ws.send(data)
      } catch {
        // best effort — close happens via the ws event
      }
    },
    close(code, reason) {
      try {
        ws.close(code, reason)
      } catch {
        // best effort
      }
    },
    on(event, listener) {
      if (event === "message") {
        ws.on("message", (data) => {
          const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf-8") : String(data)
          ;(listener as (data: string) => void)(text)
        })
      } else if (event === "close") {
        ws.on("close", () => (listener as () => void)())
      }
    },
  }
}
