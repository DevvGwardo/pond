import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { cors } from "hono/cors"
import { WebSocketServer } from "ws"
import type { IncomingMessage } from "node:http"
import * as net from "node:net"
import type { Socket as NetSocket } from "node:net"
import chokidar from "chokidar"
import * as fs from "node:fs"
import * as path from "node:path"
import { buildClient } from "./bundler.js"
import { createRuntime } from "./runtime.js"
import type { CapsuleContext, SocketHandler, SocketLike } from "./server/index.js"

// Probe one network stack: resolves true if `port` is bindable on `host`.
// Only a real EADDRINUSE/EACCES counts as "in use" — an unavailable address
// (e.g. ::1 on an IPv4-only host) resolves true so a missing IPv6 stack
// doesn't make every port look busy and stall findAvailablePort.
function probePort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once("error", (err: NodeJS.ErrnoException) => resolve(err.code !== "EADDRINUSE" && err.code !== "EACCES"))
    srv.once("listening", () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

// A port is free only if BOTH loopback stacks are bindable. An IPv4-only probe
// missed a server holding just the IPv6 side of a port (e.g. a Next.js dev
// server on `::`): pond would then take the IPv4 side of the same port and
// `localhost` — IPv6-first on macOS — would route to the other app instead of
// the capsule. Checking both stacks makes findAvailablePort walk past it.
async function isPortFree(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([probePort(port, "127.0.0.1"), probePort(port, "::1")])
  return v4 && v6
}

// Walk forward from the requested port until we find one free, so a
// kanban-bridge (or anything else) squatting on 3000 doesn't crash dev with
// EADDRINUSE — we just listen on 3001 and tell the user.
async function findAvailablePort(start: number, maxAttempts = 20): Promise<number> {
  for (let p = start; p < start + maxAttempts; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error(`No free port in range ${start}–${start + maxAttempts - 1}`)
}

export async function startDevServer(requestedPort: number): Promise<void> {
  const port = await findAvailablePort(requestedPort)
  if (port !== requestedPort) {
    console.log(`  port ${requestedPort} in use — using ${port} instead`)
  }
  const cwd = process.cwd()
  const serverFile = path.join(cwd, "server", "index.ts")
  const clientFile = path.join(cwd, "client", "index.tsx")
  const envFile = path.join(cwd, ".env.pond.server")

  if (!fs.existsSync(serverFile)) {
    console.error("No server/index.ts found. Run `npx pond new <name>` first.")
    process.exit(1)
  }

  let guestName = "guest"
  let currentApp = new Hono()
  let currentRuntime: {
    def: { sockets?: Record<string, { _kind: "socket"; handler: SocketHandler }> }
    buildContext: (cookieHeader: string | null | undefined) => Promise<CapsuleContext>
  } | null = null
  let clientHtml = ""
  const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const logClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const recentLogs: Array<{ timestamp: string; level: "info" | "error"; message: string; data?: any }> = []
  const encoder = new TextEncoder()

  const broadcast = (clients: Set<ReadableStreamDefaultController<Uint8Array>>, payload: unknown) => {
    const chunk = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
    for (const client of clients) {
      try {
        client.enqueue(chunk)
      } catch {
        clients.delete(client)
      }
    }
  }

  // Block cross-origin/DNS-rebind attacks against the /__pond/* debug surface.
  // Without this, any tab the dev visits can hit the dev server on loopback
  // and read the running app's DB or logs (cors() at the outer app sets
  // Access-Control-Allow-Origin:*). We can't rely on loopback binding alone —
  // the browser IS on loopback. So: same-origin Origin if present, and a
  // Host header that points at loopback (defeats DNS rebinding).
  const isInternalRouteSafe = (originHeader: string | null | undefined, hostHeader: string | null | undefined) => {
    const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
    if (!hostHeader || !expectedHosts.has(hostHeader.toLowerCase())) return false
    if (!originHeader) return true
    try {
      const o = new URL(originHeader)
      const h = o.host.toLowerCase()
      return expectedHosts.has(h)
    } catch {
      return false
    }
  }

  const buildApp = async () => {
    const nextApp = new Hono()
    nextApp.use("*", cors())
    nextApp.use("/__pond/*", async (c, next) => {
      if (!isInternalRouteSafe(c.req.header("origin"), c.req.header("host"))) {
        return c.json({ error: "forbidden" }, 403)
      }
      await next()
    })

    clientHtml = await buildClient(clientFile, { liveReload: true })
    nextApp.get("/", (c) => c.html(clientHtml))
    nextApp.get("/assets/*", (c) => c.text("", 404))

    const runtime = await createRuntime(serverFile, cwd, {
      port,
      getGuestAuth: () => ({
        isGuest: true,
        userId: guestName,
        displayName: guestName,
      }),
      onLog: (entry) => {
        recentLogs.push(entry)
        if (recentLogs.length > 200) recentLogs.shift()
        broadcast(logClients, entry)
      },
    })

    runtime.mount(nextApp)

    nextApp.get("/__pond/db/tables", (c) => {
      const tables = runtime.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
        .all() as Array<{ name: string }>
      return c.json(tables.map((table) => table.name))
    })

    nextApp.get("/__pond/db/dump/:table", (c) => {
      const table = c.req.param("table")
      const exists = runtime.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      if (!exists) return c.json({ error: `Unknown table: ${table}` }, 404)
      const rows = runtime.db.prepare(`SELECT * FROM ${table}`).all()
      return c.json(rows)
    })

    nextApp.get("/__pond/logs", (c) => {
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
      return new Response(
        new ReadableStream({
          start(controller) {
            streamController = controller
            logClients.add(controller)
            for (const entry of recentLogs) {
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

    nextApp.get("/__pond/inspect", (c) =>
      c.json({
        schema: Object.keys(runtime.def.schema),
        queries: Object.keys(runtime.def.queries),
        mutations: Object.keys(runtime.def.mutations),
        endpoints: Object.keys(runtime.def.endpoints ?? {}),
        env: {
          GOOGLE_REDIRECT_URI: runtime.env.GOOGLE_REDIRECT_URI,
        },
        auth: {
          guestName,
        },
      }),
    )

    nextApp.post("/__pond/auth/guest", async (c) => {
      // The dev server binds to 127.0.0.1 only (see serve() below), so this
      // endpoint is only reachable from loopback. We still validate the name
      // because it gets echoed into HTML in some dev tools.
      const body = (await c.req.json().catch(() => ({}))) as { name?: unknown }
      const raw = typeof body.name === "string" ? body.name.trim() : ""
      if (raw && !/^[A-Za-z0-9 _-]{1,32}$/.test(raw)) {
        return c.json({ error: "guest name must match /^[A-Za-z0-9 _-]{1,32}$/" }, 400)
      }
      guestName = raw || "guest"
      return c.json({
        ok: true,
        isGuest: true,
        userId: guestName,
        displayName: guestName,
      })
    })

    currentApp = nextApp
    currentRuntime = runtime
  }

  const rebuild = async (reason: "server" | "client" | "env") => {
    try {
      await buildApp()
      broadcast(reloadClients, { reason })
      console.log(`[pond] rebuilt ${reason}`)
    } catch (error) {
      console.error(`[pond] failed to rebuild ${reason}`, error)
    }
  }

  await buildApp()

  const app = new Hono()
  app.use("*", cors())

  app.get("/__pond_reload", () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    return new Response(
      new ReadableStream({
        start(controller) {
          streamController = controller
          reloadClients.add(controller)
        },
        cancel() {
          if (streamController) {
            reloadClients.delete(streamController)
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

  app.all("*", async (c) => {
    return currentApp.fetch(c.req.raw)
  })

  // Trailing-edge debounce so a burst of file changes (git checkout, IDE save
  // on multiple files) collapses into a single rebuild per source area.
  const DEBOUNCE_MS = 200
  const pendingReasons = new Set<"server" | "client" | "env">()
  let debounceTimer: NodeJS.Timeout | null = null
  const scheduleRebuild = (reason: "server" | "client" | "env") => {
    pendingReasons.add(reason)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(async () => {
      debounceTimer = null
      const reasons = [...pendingReasons]
      pendingReasons.clear()
      // server changes invalidate everything; otherwise just rebuild the
      // most specific changed area.
      const r: "server" | "client" | "env" = reasons.includes("server")
        ? "server"
        : reasons.includes("env")
          ? "env"
          : "client"
      await rebuild(r)
    }, DEBOUNCE_MS)
  }

  chokidar
    .watch([serverFile, clientFile, envFile], {
      ignoreInitial: true,
    })
    .on("change", (changedPath) => {
      if (changedPath === clientFile) {
        scheduleRebuild("client")
        return
      }
      if (changedPath === envFile) {
        scheduleRebuild("env")
        return
      }
      scheduleRebuild("server")
    })

  console.log(`\n  pond dev server running at http://localhost:${port}\n`)

  const httpServer = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" })

  // Same /api/socket/<name> upgrade flow as start-server.ts, except hot-reload
  // aware — each connection looks up the live capsule definition rather than
  // capturing the one we had at boot.
  const wss = new WebSocketServer({ noServer: true })
  httpServer.on("upgrade", (req: IncomingMessage, socket: NetSocket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const match = url.pathname.match(/^\/api\/socket\/([a-zA-Z_][a-zA-Z0-9_]*)$/)
    if (!match || !currentRuntime) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    const def = currentRuntime.def.sockets?.[match[1]]
    if (!def) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        const ctx = await currentRuntime!.buildContext(req.headers.cookie ?? null)
        const wrapped: SocketLike = {
          send: (data) => {
            try {
              ws.send(data)
            } catch {
              // best effort
            }
          },
          close: (code, reason) => {
            try {
              ws.close(code, reason)
            } catch {
              // best effort
            }
          },
          on: (event, listener) => {
            if (event === "message") {
              ws.on("message", (raw) => {
                const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw)
                ;(listener as (data: string) => void)(text)
              })
            } else if (event === "close") {
              ws.on("close", () => (listener as () => void)())
            }
          },
        }
        await def.handler(ctx, wrapped)
      } catch (err) {
        try {
          ws.close(1011, err instanceof Error ? err.message.slice(0, 120) : "handler error")
        } catch {
          // best effort
        }
      }
    })
  })
}
