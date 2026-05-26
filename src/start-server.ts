import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { cors } from "hono/cors"
import * as fs from "node:fs"
import { createRuntimeFromDeployBundle } from "./runtime.js"

interface StartBundleServerOptions {
  bundlePath: string
  clientPath?: string
  cwd: string
  port: number
  inspectSecret?: string
  publicInspect?: boolean
}

export async function createBundleServerApp(options: StartBundleServerOptions): Promise<Hono> {
  const app = new Hono()
  app.use("*", cors())
  const encoder = new TextEncoder()
  const logClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const recentLogs: Array<{ timestamp: string; level: "info" | "error"; message: string; data?: any }> = []

  const runtime = await createRuntimeFromDeployBundle(options.bundlePath, options.cwd, {
    port: options.port,
    onLog: (entry) => {
      recentLogs.push(entry)
      if (recentLogs.length > 200) recentLogs.shift()
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

  return app
}

export async function serveBundleServer(options: StartBundleServerOptions) {
  const app = await createBundleServerApp(options)
  const server = serve({ fetch: app.fetch, port: options.port })
  return { app, server }
}
