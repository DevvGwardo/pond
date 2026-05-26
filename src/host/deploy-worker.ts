import { serveBundleServer } from "../start-server.js"

interface BootOptions {
  bundlePath: string
  clientPath?: string
  cwd: string
  port: number
  hostname?: string
  inspectSecret?: string
  publicInspect?: boolean
  allowedOrigins?: string[]
}

type ParentMessage =
  | { type: "boot"; options: BootOptions }
  | { type: "shutdown" }

let server: { close: (cb?: (err?: Error) => void) => void } | null = null

function send(msg: object) {
  if (process.send) process.send(msg)
}

process.on("message", async (msg: ParentMessage) => {
  if (msg.type === "boot") {
    try {
      const result = await serveBundleServer(msg.options)
      server = result.server
      send({ type: "booted", port: result.port })
    } catch (err: any) {
      send({ type: "error", message: err?.message ?? String(err) })
      process.exit(1)
    }
  } else if (msg.type === "shutdown") {
    if (!server) {
      send({ type: "closed" })
      process.exit(0)
    }
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    send({ type: "closed" })
    process.exit(0)
  }
})

process.on("disconnect", () => {
  process.exit(0)
})
