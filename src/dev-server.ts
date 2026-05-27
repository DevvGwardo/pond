import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { cors } from "hono/cors"
import { WebSocketServer } from "ws"
import type { IncomingMessage } from "node:http"
import type { Socket as NetSocket } from "node:net"
import chokidar from "chokidar"
import * as fs from "node:fs"
import * as path from "node:path"
import { buildClient } from "./bundler.js"
import { createRuntime } from "./runtime.js"
import type { CapsuleContext, SocketHandler, SocketLike } from "./server/index.js"

export async function startDevServer(port: number): Promise<void> {
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

  const buildApp = async () => {
    const nextApp = new Hono()
    nextApp.use("*", cors())

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
