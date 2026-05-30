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
      const p = typeof addr === "object" && addr ? addr.port : 0
      s.close(() => resolve(p))
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
  throw new Error(`host did not become healthy within ${timeoutMs}ms`)
}

const TINY_SERVER_SRC = `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`

function tinySourceFiles(serverSrc = TINY_SERVER_SRC) {
  return { "server/index.ts": serverSrc, "package.json": '{"name":"test-cap","private":true,"type":"module"}\n' }
}

let hostProc = null
let dataDir = null
let port = 0
let apiUrl = ""
const hostToken = randomBytes(16).toString("hex")
let ownerToken = ""
let ownedDeployId = ""
let anonDeployId = ""
let anonClaimToken = ""

async function startHost() {
  port = await pickFreePort()
  apiUrl = `http://127.0.0.1:${port}`
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-ide-test-"))
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
      "localhost",
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

  // bootstrap admin
  const userRes = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "owner" }),
  })
  const userBody = await userRes.json()
  ownerToken = userBody.token

  // create an owned deploy
  const ownedRes = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  const ownedBody = await ownedRes.json()
  ownedDeployId = ownedBody.deployId

  // create an anonymous deploy for the negative tests
  const anonRes = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  const anonBody = await anonRes.json()
  anonDeployId = anonBody.deployId
  anonClaimToken = anonBody.claimToken
})

after(async () => {
  try {
    await stopHost()
  } finally {
    // maxRetries/retryDelay: Windows can briefly lock a worker's SQLite handle
    // after the host exits, so a bare rmSync races with EBUSY.
    if (dataDir && existsSync(dataDir))
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("GET /files returns the source tree for owner", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  const paths = body.files.map((f) => f.path)
  assert.ok(paths.includes("server/index.ts"), `expected server/index.ts: ${JSON.stringify(paths)}`)
  assert.ok(paths.includes("package.json"))
})

test("GET /files/server/index.ts returns file contents", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/server/index.ts`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /capsule\(/)
})

test("PUT /files/shared/notes.md writes a new file and GET returns it", async () => {
  const put = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/shared/notes.md`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "text/plain" },
    body: "# hello\n",
  })
  assert.equal(put.status, 200)
  const putBody = await put.json()
  assert.equal(putBody.path, "shared/notes.md")
  const get = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/shared/notes.md`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(get.status, 200)
  assert.equal(await get.text(), "# hello\n")
})

test("DELETE /files removes a non-required file", async () => {
  const del = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/shared/notes.md`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(del.status, 200)
  const get = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/shared/notes.md`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(get.status, 404)
})

test("DELETE refuses to remove server/index.ts", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/server/index.ts`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(res.status, 400)
})

test("PUT rejects path traversal", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/server/../../escape.ts`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "text/plain" },
    body: "x",
  })
  assert.ok(res.status === 400 || res.status === 404, `expected 400/404, got ${res.status}`)
})

test("PUT rejects path outside allowed roots", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/.env.pond.server`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "text/plain" },
    body: "SECRET=x",
  })
  assert.equal(res.status, 400)
})

test("POST /files/move renames a file", async () => {
  // first create
  await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/shared/a.md`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "text/plain" },
    body: "a\n",
  })
  const mv = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/move`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ from: "shared/a.md", to: "shared/b.md" }),
  })
  assert.equal(mv.status, 200)
  const get = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/shared/b.md`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(get.status, 200)
  assert.equal(await get.text(), "a\n")
})

test("file APIs reject anonymous deploys with 403", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${anonDeployId}/files`, {
    headers: { "x-pond-claim-token": anonClaimToken },
  })
  assert.equal(res.status, 403)
})

test("file APIs reject non-owner bearer token with 403", async () => {
  // create a second user who doesn't own ownedDeployId
  const otherRes = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "outsider" }),
  })
  const otherBody = await otherRes.json()
  const res = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files`, {
    headers: { authorization: `Bearer ${otherBody.token}` },
  })
  assert.equal(res.status, 403)
})

test("file APIs reject missing auth with 401", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files`)
  assert.equal(res.status, 401)
})

// ---- /build ----

test("POST /build rebuilds successfully after a valid edit", async () => {
  const newSrc = `import { capsule, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: {
    items: query((ctx) => ctx.db.items.all()),
    count: query((ctx) => ctx.db.items.all().length),
  },
  mutations: {},
})
`
  const put = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/server/index.ts`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "text/plain" },
    body: newSrc,
  })
  assert.equal(put.status, 200)
  const build = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/build`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(build.status, 200)
  const body = await build.json()
  assert.equal(body.ok, true, `expected ok:true, got ${JSON.stringify(body)}`)
  assert.ok(typeof body.bundleHash === "string" && body.bundleHash.length === 64)
  assert.ok(typeof body.bundleBytes === "number" && body.bundleBytes > 0)
  assert.ok(typeof body.durationMs === "number")
})

test("POST /build returns ok:false with errors on syntax error", async () => {
  const broken = `import { capsule } from "pond/server"
this is not valid typescript &&&
export default capsule({ schema: {}, queries: {}, mutations: {} })
`
  await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/files/server/index.ts`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "text/plain" },
    body: broken,
  })
  const build = await fetch(`${apiUrl}/api/deploys/${ownedDeployId}/build`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(build.status, 200)
  const body = await build.json()
  assert.equal(body.ok, false)
  assert.ok(Array.isArray(body.errors) && body.errors.length > 0, `expected errors[]: ${JSON.stringify(body)}`)
  assert.ok(typeof body.errors[0].text === "string")
})

test("POST /build rejects anonymous deploys with 403", async () => {
  const res = await fetch(`${apiUrl}/api/deploys/${anonDeployId}/build`, {
    method: "POST",
    headers: { "x-pond-claim-token": anonClaimToken },
  })
  assert.equal(res.status, 403)
})

// ---- /ide/:deployId ----

test("GET /ide/:deployId serves the SPA with bootstrap injected", async () => {
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: `/ide/${ownedDeployId}`,
        headers: { host: `localhost:${port}` },
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
  assert.match(result.body, /window\.__POND_IDE/)
  assert.match(result.body, new RegExp(`"deployId":"${ownedDeployId}"`))
  assert.match(result.body, /<div id="root"/)
})

test("GET /ide/unknown returns 404", async () => {
  const http = await import("node:http")
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/ide/deadbeefdeadbeef",
        headers: { host: `localhost:${port}` },
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
  assert.equal(result.status, 404)
})

// ---- agent docs ----

async function getBare(p) {
  const http = await import("node:http")
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: p,
        headers: { host: `localhost:${port}` },
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
}

test("GET /llms.txt serves the agent docs index", async () => {
  const r = await getBare("/llms.txt")
  assert.equal(r.status, 200)
  assert.match(r.ct, /text\/plain/)
  assert.match(r.body, /# Pond Docs/)
  assert.match(r.body, /llms-full\.txt/)
})

test("GET /llms-full.txt serves the consolidated reference", async () => {
  const r = await getBare("/llms-full.txt")
  assert.equal(r.status, 200)
  assert.match(r.body, /Pond Server API Reference/)
  assert.match(r.body, /Pond Client API Reference/)
})

test("GET /docs/api-reference.md serves the canonical server reference", async () => {
  const r = await getBare("/docs/api-reference.md")
  assert.equal(r.status, 200)
  assert.match(r.ct, /text\/markdown/)
  assert.match(r.body, /pond\/server/)
})

test("GET /docs/../etc/passwd is rejected", async () => {
  const r = await getBare("/docs/..%2Fetc%2Fpasswd")
  assert.ok(r.status === 404 || r.status === 400, `expected 404/400, got ${r.status}`)
})
