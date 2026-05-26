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
  restrictNetwork?: boolean
}

type ParentMessage =
  | { type: "boot"; options: BootOptions }
  | { type: "shutdown" }

let server: { close: (cb?: (err?: Error) => void) => void } | null = null

function send(msg: object) {
  if (process.send) process.send(msg)
}

async function installNetworkRestriction() {
  const denyMsg = "Outbound network access disabled for anonymous deploys"
  const denyFetch = () => {
    throw new Error(denyMsg)
  }
  ;(globalThis as any).fetch = denyFetch
  try {
    // @ts-ignore — undici may not be available
    const undici: any = await import("undici")
    if (undici && typeof undici === "object") undici.fetch = denyFetch
  } catch {
    // undici may not be installed; best-effort
  }
  // Patch net.Socket.prototype.connect — blocks node:http, node:https, tls.connect,
  // and any direct net.Socket usage. This isn't airtight (a determined capsule could
  // load a native module that bypasses the JS layer), but it raises the bar from
  // "one line of node:https" to "you have to ship native code."
  try {
    const net = await import("node:net")
    const origConnect = net.Socket.prototype.connect
    net.Socket.prototype.connect = function (...args: any[]) {
      const a0 = args[0]
      let host = ""
      let port: number | string = ""
      if (typeof a0 === "object" && a0 !== null) {
        // IPC unix socket path is allowed only if the path is inside cwd (deploy dir);
        // for safety just block all paths too.
        if (typeof a0.path === "string") {
          throw new Error(`${denyMsg} (unix socket: ${a0.path})`)
        }
        host = String(a0.host ?? a0.address ?? "")
        port = a0.port
      } else if (typeof a0 === "number" || typeof a0 === "string") {
        port = a0
        if (typeof args[1] === "string") host = args[1]
      }
      throw new Error(`${denyMsg} (attempted connect to ${host || "<unspecified>"}:${port})`)
      // unreachable; keeps origConnect reference live for the linter
      // @ts-ignore
      return origConnect.apply(this, args)
    }
  } catch {
    // node:net should always be available; best-effort
  }
}

process.on("message", async (msg: ParentMessage) => {
  if (msg.type === "boot") {
    try {
      if (msg.options.restrictNetwork) {
        await installNetworkRestriction()
      }
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
