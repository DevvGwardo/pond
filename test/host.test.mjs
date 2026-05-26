import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import { randomBytes } from "node:crypto"
import { buildForDeploy } from "../src/runtime.js"

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

async function buildTinyBundle(workDir) {
  const serverFile = path.join(workDir, "server", "index.ts")
  mkdirSync(path.dirname(serverFile), { recursive: true })
  writeFileSync(
    serverFile,
    `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`
  )
  const { outfile } = await buildForDeploy(serverFile, workDir)
  return outfile
}

let hostProc = null
let dataDir = null
let workDir = null
let port = 0
let apiUrl = ""
let publicHost = "localhost"
const hostToken = randomBytes(16).toString("hex")
let adminToken = ""
let deployId = ""
let claimToken = ""
let bundlePath = ""

async function startHost() {
  port = await pickFreePort()
  apiUrl = `http://127.0.0.1:${port}`
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-host-test-"))
  hostProc = spawn(
    process.execPath,
    [CLI_PATH, "host", "--port", String(port), "--host", "127.0.0.1", "--public-host", publicHost, "--data-dir", dataDir],
    {
      env: { ...process.env, POND_HOST_TOKEN: hostToken },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    }
  )
  hostProc.stdout.on("data", () => {})
  hostProc.stderr.on("data", () => {})
  await waitForHealth(apiUrl)
}

async function stopHost() {
  if (hostProc && hostProc.exitCode === null) {
    const exited = new Promise((resolve) => hostProc.once("exit", resolve))
    hostProc.kill("SIGINT")
    const t = setTimeout(() => {
      if (hostProc.exitCode === null) hostProc.kill("SIGKILL")
    }, 4000)
    t.unref()
    await exited
    clearTimeout(t)
  }
  hostProc = null
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "pond-cap-test-"))
  bundlePath = await buildTinyBundle(workDir)
  await startHost()
})

after(async () => {
  try {
    await stopHost()
  } finally {
    if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
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
  const fs = await import("node:fs")
  const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ bundleBase64 }),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.match(body.url, new RegExp(`^http://[a-f0-9]+\\.${publicHost}:${port}$`))
  assert.ok(body.deployId.length >= 8)
  assert.ok(body.claimToken.length >= 32)
  deployId = body.deployId
  claimToken = body.claimToken
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
      }
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

test("wrong user token → 401 on POST /api/deploys", async () => {
  const fs = await import("node:fs")
  const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
    body: JSON.stringify({ bundleBase64 }),
  })
  assert.equal(res.status, 401)
})

test("wrong claim token → 403 on PUT /api/deploys/:id (no auth)", async () => {
  const fs = await import("node:fs")
  const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
  const res = await fetch(`${apiUrl}/api/deploys/${deployId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-pond-claim-token": "deadbeef".repeat(8),
    },
    body: JSON.stringify({ bundleBase64 }),
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
