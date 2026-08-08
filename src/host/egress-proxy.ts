// Allowlisting egress proxy for capsule outbound traffic.
//
// In the uniform-isolation model every capsule is network-restricted at the OS
// layer (deploy/capsule-egress.nft drops all new outbound except loopback to
// THIS proxy's port). A capsule that needs to reach an approved external host
// (Stripe, OpenAI, …) must go through here. The proxy is the single sanctioned
// egress path, so it is also the single place the per-deploy allowlist is
// enforced — addon-proof, because even a native module that bypasses the JS
// network shim still can't leave the box except via this port.
//
// Each capsule worker is launched with HTTP(S)_PROXY pointing here and a
// per-deploy Proxy-Authorization credential (deployId:secret). The proxy maps
// the credential to that deploy's allowlist via the injected `resolve` dep, so
// one shared proxy enforces distinct allowlists per tenant without trusting the
// (shared-loopback) source address.
//
// The proxy itself runs in the control-plane process — NOT in a capsule cgroup
// — so its own DNS + outbound is unrestricted by the capsule egress firewall.
// It does name resolution on the capsule's behalf for allowlisted hosts.

import * as http from "node:http"
import * as net from "node:net"

export interface EgressProxyDeps {
  // Validate the capsule credential and return that deploy's allowlist of host
  // patterns, or null if the credential is unknown/invalid. Implementations
  // MUST compare the secret in constant time.
  resolve(deployId: string, secret: string): string[] | null
}

// Match a target hostname against an allowlist of patterns. A pattern is either
// an exact host ("api.stripe.com") or a leading-wildcard suffix ("*.openai.com",
// which matches "api.openai.com" but NOT the bare "openai.com"). Matching is
// case-insensitive and ignores a trailing dot (FQDN form). Ports are matched
// separately by the caller; patterns are host-only.
export function hostAllowed(targetHost: string, allowlist: readonly string[]): boolean {
  const host = targetHost.toLowerCase().replace(/\.$/, "")
  if (!host) return false
  for (const raw of allowlist) {
    const pattern = raw.toLowerCase().replace(/\.$/, "").trim()
    if (!pattern) continue
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1) // ".openai.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return true
    } else if (host === pattern) {
      return true
    }
  }
  return false
}

// Ports a capsule may reach through the proxy. An allowlisted host must not
// become a free port-forward (CONNECT api.stripe.com:22), so only the web
// ports are reachable. Operators with a real need for non-web ports can widen
// the set at startup.
export const DEFAULT_ALLOWED_PROXY_PORTS = new Set([80, 443])

// Parse a "Basic base64(deployId:secret)" Proxy-Authorization header into its
// parts. Returns null on any malformed input.
function parseProxyAuth(header: string | undefined): { deployId: string; secret: string } | null {
  if (!header) return null
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header.trim())
  if (!m) return null
  let decoded: string
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf-8")
  } catch {
    return null
  }
  const idx = decoded.indexOf(":")
  if (idx < 0) return null
  return { deployId: decoded.slice(0, idx), secret: decoded.slice(idx + 1) }
}

// Split "host:port" (or "host" with a default port) into parts. Handles bare
// IPv6 in brackets ("[::1]:443"). Returns null if no usable host.
function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  let host = authority
  let port = defaultPort
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority)
  if (v6) {
    host = v6[1]
    if (v6[2]) port = Number(v6[2])
  } else {
    const i = authority.lastIndexOf(":")
    if (i >= 0 && /^\d+$/.test(authority.slice(i + 1))) {
      host = authority.slice(0, i)
      port = Number(authority.slice(i + 1))
    }
  }
  if (!host) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

export interface EgressProxyHandle {
  server: http.Server
  port: number
  close: () => Promise<void>
}

// Start the egress proxy. Binds to loopback by default so only same-host
// capsules (routed by the nft rule) can reach it. Returns the bound port (handy
// when port 0 is requested in tests). `allowedPorts` defaults to web ports
// only — see DEFAULT_ALLOWED_PROXY_PORTS.
export function startEgressProxy(
  opts: { port: number; hostname?: string; allowedPorts?: ReadonlySet<number> },
  deps: EgressProxyDeps,
): Promise<EgressProxyHandle> {
  const hostname = opts.hostname ?? "127.0.0.1"
  const allowedPorts = opts.allowedPorts ?? DEFAULT_ALLOWED_PROXY_PORTS
  const portAllowed = (port: number) => allowedPorts.has(port)

  const authorize = (req: { headers: http.IncomingHttpHeaders }, targetHost: string): boolean => {
    const creds = parseProxyAuth(req.headers["proxy-authorization"])
    if (!creds) return false
    const allowlist = deps.resolve(creds.deployId, creds.secret)
    if (!allowlist) return false
    return hostAllowed(targetHost, allowlist)
  }

  // The per-deploy Proxy-Authorization credential authorizes the REQUEST; it
  // must never travel upstream to the allowlisted host (it would leak the
  // deploy's egress secret to every host the operator allowlists).
  const stripProxyAuth = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
    const out: http.OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase()
      if (lk === "proxy-authorization" || lk === "proxy-connection" || lk === "connection") continue
      out[k] = v
    }
    return out
  }

  const server = http.createServer((req, res) => {
    // Plain-HTTP forward proxying. Absolute-form request URI per RFC 7230.
    let parsed: URL
    try {
      parsed = new URL(req.url ?? "")
    } catch {
      res.writeHead(400).end("bad request URI")
      return
    }
    if (parsed.protocol !== "http:") {
      res.writeHead(400).end("only absolute http URIs are proxied; use CONNECT for https")
      return
    }
    if (!authorize(req, parsed.hostname)) {
      res.writeHead(403).end("egress to this host is not allowed")
      return
    }
    const port = parsed.port ? Number(parsed.port) : 80
    if (!portAllowed(port)) {
      res.writeHead(403).end(`egress to port ${port} is not allowed`)
      return
    }
    const upstream = http.request(
      {
        host: parsed.hostname,
        port,
        method: req.method,
        path: parsed.pathname + parsed.search,
        headers: { ...stripProxyAuth(req.headers), host: parsed.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502)
      res.end("upstream error")
    })
    req.pipe(upstream)
  })

  // HTTPS tunneling via CONNECT — the common path (undici/fetch uses CONNECT
  // for https targets). We never terminate TLS; we only gate the destination
  // host then splice bytes, so there's no interception of capsule traffic.
  server.on("connect", (req, clientSocket, head) => {
    const target = splitHostPort(req.url ?? "", 443)
    const denyAndClose = (line: string) => {
      clientSocket.write(line)
      clientSocket.end()
    }
    if (!target) return denyAndClose("HTTP/1.1 400 Bad Request\r\n\r\n")
    if (!authorize(req, target.host)) return denyAndClose("HTTP/1.1 403 Forbidden\r\n\r\n")
    if (!portAllowed(target.port)) return denyAndClose("HTTP/1.1 403 Forbidden\r\n\r\n")

    // `timeout` bounds the connect phase (a wedged upstream must not hang the
    // tunnel); it is disarmed once the tunnel is spliced.
    const upstream = net.connect({ port: target.port, host: target.host, timeout: 10_000 }, () => {
      upstream.setTimeout(0)
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on("timeout", () => {
      upstream.destroy()
      denyAndClose("HTTP/1.1 504 Gateway Timeout\r\n\r\n")
    })
    upstream.on("error", () => denyAndClose("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
    clientSocket.on("error", () => upstream.destroy())
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, hostname, () => {
      server.removeListener("error", reject)
      const addr = server.address()
      const boundPort = typeof addr === "object" && addr ? addr.port : opts.port
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}
