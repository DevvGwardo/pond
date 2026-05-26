import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { cors } from "hono/cors"
import chokidar from "chokidar"
import * as fs from "node:fs"
import * as path from "node:path"
import { buildClient } from "./bundler.js"
import { createRuntime } from "./runtime.js"

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
  let clientHtml = ""
  const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const logClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const recentLogs: Array<{ timestamp: string; level: "info" | "error"; message: string; data?: any }> = []
  const encoder = new TextEncoder()

  const broadcast = (
    clients: Set<ReadableStreamDefaultController<Uint8Array>>,
    payload: unknown
  ) => {
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
      const exists = runtime.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table)
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
        }
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
      })
    )

    nextApp.post("/__pond/auth/guest", async (c) => {
      const body = (await c.req.json()) as { name?: string }
      guestName = body.name?.trim() || "guest"
      return c.json({
        ok: true,
        isGuest: true,
        userId: guestName,
        displayName: guestName,
      })
    })

    currentApp = nextApp
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
      }
    )
  })

  app.all("*", async (c) => {
    return currentApp.fetch(c.req.raw)
  })

  chokidar
    .watch([serverFile, clientFile, envFile], {
      ignoreInitial: true,
    })
    .on("change", async (changedPath) => {
      if (changedPath === clientFile) {
        await rebuild("client")
        return
      }
      if (changedPath === envFile) {
        await rebuild("env")
        return
      }
      await rebuild("server")
    })

  console.log(`\n  pond dev server running at http://localhost:${port}\n`)

  serve({ fetch: app.fetch, port })
}
