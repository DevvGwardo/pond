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

function tinySourceFiles() {
  return {
    "server/index.ts": TINY_SERVER_SRC,
    "package.json": '{"name":"test-cap","private":true,"type":"module"}\n',
  }
}

let hostProc = null
let dataDir = null
let port = 0
let apiUrl = ""
const hostToken = randomBytes(16).toString("hex")
let adminToken = ""

async function startHost() {
  port = await pickFreePort()
  apiUrl = `http://127.0.0.1:${port}`
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-host-cap-test-"))
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
      // Ceiling of 1 makes the gate trivially observable.
      "--max-active-capsules",
      "1",
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

async function createDeploy(token) {
  return await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
}

before(async () => {
  await startHost()
  const res = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "admin" }),
  })
  assert.equal(res.status, 201)
  adminToken = (await res.json()).token
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

test("first capsule is admitted, second is refused with 503 + Retry-After", async () => {
  const first = await createDeploy(adminToken)
  assert.equal(first.status, 201)

  const second = await createDeploy(adminToken)
  assert.equal(second.status, 503)
  assert.equal(second.headers.get("retry-after"), "30")
  const body = await second.json()
  assert.match(body.error, /unavailable/i)
})

test("deleting a capsule frees its slot so a new create succeeds", async () => {
  // The box still holds the one capsule from the previous test. Find and delete
  // it, which awaits stopDeploy() and frees the slot synchronously.
  const list = await fetch(`${apiUrl}/api/deploys`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(list.status, 200)
  const { deploys } = await list.json()
  assert.ok(Array.isArray(deploys) && deploys.length >= 1)
  const del = await fetch(`${apiUrl}/api/deploys/${deploys[0].deployId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(del.status, 200)

  const third = await createDeploy(adminToken)
  assert.equal(third.status, 201)
})
