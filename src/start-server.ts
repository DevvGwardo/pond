import { Hono } from "hono"
import { serve } from "@hono/node-server"
import * as fs from "node:fs"
import * as path from "node:path"
import { createRuntimeFromDeployBundle } from "./runtime.js"

interface StartBundleServerOptions {
  bundlePath: string
  clientPath?: string
  cwd: string
  port: number
  hostname?: string
  inspectSecret?: string
  publicInspect?: boolean
  allowedOrigins?: string[]
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
  allowedOrigins: string[]
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
    "vary": "Origin",
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

  function canInspect(headerToken: string | undefined) {
    if (options.publicInspect) return true
    if (!options.inspectSecret) return true
    return headerToken === options.inspectSecret
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
    const exists = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
    if (!exists) return c.json({ error: `Unknown table: ${table}` }, 404)
    return c.json(runtime.db.prepare(`SELECT * FROM ${table}`).all())
  })

  app.get("/__pond/logs", (c) => {
    if (!canInspect(c.req.header("x-pond-claim-token"))) {
      return c.json({ error: "Forbidden" }, 403)
    }
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    return new Response(
      new ReadableStream({
        start(controller) {
          streamController = controller
          logClients.add(controller)
          const replay = recentLogs.length < RECENT_LOG_CAP
            ? readRecentLogsFromDisk(logFile, RECENT_LOG_CAP)
            : recentLogs
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
      }
    )
  })

  return app
}

export async function serveBundleServer(options: StartBundleServerOptions) {
  const app = await createBundleServerApp(options)
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: options.port, hostname: options.hostname }, (info) => {
      resolve({ server: s, port: info.port })
    })
    s.once("error", reject)
  })
  return { app, server, port }
}
