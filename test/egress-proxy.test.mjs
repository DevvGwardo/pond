// Tests for the allowlisting egress proxy. The host pattern matching and the
// proxy's authn + allowlist enforcement are platform-independent (plain Node
// networking), so they run anywhere — unlike the nft/cgroup layer they back.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import * as http from "node:http"
import * as net from "node:net"

import { hostAllowed, startEgressProxy } from "../src/host/egress-proxy.js"

const cleanup = []
after(async () => {
  for (const fn of cleanup) await fn().catch(() => {})
})

test("hostAllowed: exact, wildcard, and rejection semantics", () => {
  assert.equal(hostAllowed("api.stripe.com", ["api.stripe.com"]), true)
  assert.equal(hostAllowed("API.Stripe.com", ["api.stripe.com"]), true, "case-insensitive")
  assert.equal(hostAllowed("api.stripe.com.", ["api.stripe.com"]), true, "trailing dot ignored")
  assert.equal(hostAllowed("api.openai.com", ["*.openai.com"]), true, "wildcard matches subdomain")
  assert.equal(hostAllowed("openai.com", ["*.openai.com"]), false, "wildcard does NOT match bare domain")
  assert.equal(hostAllowed("evil.com", ["api.stripe.com", "*.openai.com"]), false, "not in list")
  assert.equal(hostAllowed("api.stripe.com", []), false, "empty allowlist denies all")
  assert.equal(hostAllowed("notstripe.com", ["stripe.com"]), false, "no substring match")
})

// A deploy whose credential is "deploy-a"/"secret-a" may reach 127.0.0.1 only.
const deps = {
  resolve(deployId, secret) {
    if (deployId === "deploy-a" && secret === "secret-a") return ["127.0.0.1"]
    return null
  },
}
const basic = (id, secret) => "Basic " + Buffer.from(`${id}:${secret}`).toString("base64")

async function startTargetServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("hello-from-target")
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  cleanup.push(() => new Promise((r) => server.close(() => r())))
  return server.address().port
}

function proxiedHttpGet(proxyPort, absoluteUrl, authHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: absoluteUrl,
        headers: authHeader ? { "proxy-authorization": authHeader } : {},
      },
      (res) => {
        let body = ""
        res.on("data", (c) => (body += c))
        res.on("end", () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on("error", reject)
    req.end()
  })
}

test("egress proxy forwards an allowlisted HTTP target with valid credentials", async () => {
  const targetPort = await startTargetServer()
  const proxy = await startEgressProxy({ port: 0 }, deps)
  cleanup.push(proxy.close)
  const res = await proxiedHttpGet(proxy.port, `http://127.0.0.1:${targetPort}/`, basic("deploy-a", "secret-a"))
  assert.equal(res.status, 200)
  assert.equal(res.body, "hello-from-target")
})

test("egress proxy rejects a host NOT in the deploy's allowlist (403)", async () => {
  const proxy = await startEgressProxy({ port: 0 }, deps)
  cleanup.push(proxy.close)
  // 127.0.0.1 is allowed for deploy-a, but example.com is not.
  const res = await proxiedHttpGet(proxy.port, "http://example.com/", basic("deploy-a", "secret-a"))
  assert.equal(res.status, 403)
})

test("egress proxy rejects an invalid/absent credential (403)", async () => {
  const targetPort = await startTargetServer()
  const proxy = await startEgressProxy({ port: 0 }, deps)
  cleanup.push(proxy.close)
  const bad = await proxiedHttpGet(proxy.port, `http://127.0.0.1:${targetPort}/`, basic("deploy-a", "wrong-secret"))
  assert.equal(bad.status, 403, "wrong secret denied")
  const none = await proxiedHttpGet(proxy.port, `http://127.0.0.1:${targetPort}/`, undefined)
  assert.equal(none.status, 403, "missing credential denied")
})

test("egress proxy CONNECT denies a disallowed host before tunneling", async () => {
  const proxy = await startEgressProxy({ port: 0 }, deps)
  cleanup.push(proxy.close)
  const statusLine = await new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, "127.0.0.1", () => {
      sock.write(
        `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${basic("deploy-a", "secret-a")}\r\n\r\n`,
      )
    })
    let data = ""
    sock.on("data", (c) => {
      data += c
      if (data.includes("\r\n")) {
        resolve(data.split("\r\n")[0])
        sock.end()
      }
    })
    sock.on("error", reject)
  })
  assert.match(statusLine, /403/, "CONNECT to non-allowlisted host must be refused")
})
