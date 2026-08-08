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

// Probe-then-bind has a TOCTOU window (another process can grab the port
// between the probe and serve()), and serve() would otherwise emit an
// unhandled `error` event. Retry the next free port a few times before giving
// up; post-listen errors get a friendly message instead of a raw crash.
async function serveWithFallback(fetchFn: Parameters<typeof serve>[0]["fetch"], startPort: number, hostname: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const tryPort = await findAvailablePort(startPort + attempt)
    const server = serve({ fetch: fetchFn, port: tryPort, hostname })
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener("error", onError)
          resolve()
        }
        server.once("error", onError)
        server.once("listening", onListening)
      })
      server.on("error", (err) => {
        console.error(`[pond] dev server error: ${err?.message ?? err}`)
        process.exit(1)
      })
      return server
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EADDRINUSE" && code !== "EACCES") throw err
      console.log(`  port ${tryPort} in use — using ${tryPort + 1} instead`)
    }
  }
  throw new Error(`No free port in range ${startPort}–${startPort + 4}`)
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
  if (!fs.existsSync(clientFile)) {
    console.error("No client/index.tsx found. Run `npx pond new <name>` first.")
    process.exit(1)
  }

  let guestName = "guest"
  let currentApp = new Hono()
  let currentRuntime: {
    def: { sockets?: Record<string, { _kind: "socket"; handler: SocketHandler }> }
    buildContext: (cookieHeader: string | null | undefined) => Promise<CapsuleContext>
    close: () => void
  } | null = null
  let currentClose: (() => void) | null = null
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

    // Build into locals and commit only after BOTH builds succeeded — a
    // partial failure must never pair the new client HTML with the old
    // runtime (the previous code assigned clientHtml first, so a server
    // build error left the new client talking to the old API).
    const nextClientHtml = await buildClient(clientFile, { liveReload: true })
    nextApp.get("/", (c) => c.html(nextClientHtml))
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
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`))
              } catch {
                // client disconnected mid-replay
                return
              }
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

    // Commit atomically: swap the app + runtime + client HTML together, then
    // release the previous runtime's SQLite handle. The old app keeps serving
    // for the whole (async) build, so a failed rebuild leaves it untouched.
    const prevClose = currentClose
    currentApp = nextApp
    currentRuntime = runtime
    currentClose = runtime.close
    clientHtml = nextClientHtml
    prevClose?.()
  }

  // Rebuilds must be serialized: buildApp is async (esbuild + runtime boot),
  // so without a chain two rapid rebuilds race on the same .pond/server.mjs
  // and data.db, and last-writer-wins on currentApp/currentRuntime. Chaining
  // makes each rebuild wait for the previous to settle.
  let rebuildChain: Promise<void> = Promise.resolve()
  const rebuild = async (reason: "server" | "client" | "env") => {
    const run = async () => {
      try {
        await buildApp()
        broadcast(reloadClients, { reason })
        console.log(`[pond] rebuilt ${reason}`)
      } catch (error) {
        console.error(`[pond] failed to rebuild ${reason}`, error)
      }
    }
    // Run even if the previous link failed, so one broken build can't wedge
    // the chain; run() never throws, so the chain stays healthy.
    rebuildChain = rebuildChain.then(run, run)
    await rebuildChain
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

  // Watch the WHOLE project, not just the two entries: shared/* is bundled
  // into both the server and client builds, so watching only server/index.ts
  // + client/index.tsx silently ignored shared edits (stale app, no reload).
  // node_modules/.pond/.git are excluded — they change constantly and never
  // affect the bundle. Both `change` AND `add` are handled: a brand-new
  // shared/ file (or a new imported helper) is just as build-relevant as an
  // edit to an existing one.
  const onProjectChange = (changedPath: string) => {
    if (changedPath === clientFile) {
      scheduleRebuild("client")
      return
    }
    if (changedPath === envFile) {
      scheduleRebuild("env")
      return
    }
    // server/*, shared/*, package.json, or anything else that could be
    // imported — a full rebuild covers all of them.
    scheduleRebuild("server")
  }
  chokidar
    .watch(cwd, {
      ignoreInitial: true,
      ignored: (p: string) => {
        if (p === cwd) return false
        const rel = path.relative(cwd, p)
        if (!rel || rel.startsWith("..")) return true
        return /(^|\/)(node_modules|\.pond|\.git)(\/|$)/.test(rel)
      },
    })
    .on("change", onProjectChange)
    .on("add", onProjectChange)

  console.log(`\n  pond dev server running at http://localhost:${port}\n`)

  const httpServer = await serveWithFallback(app.fetch, port, "127.0.0.1")

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
