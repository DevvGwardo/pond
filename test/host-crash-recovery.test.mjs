// Phase 1 self-healing: a capsule whose worker dies unexpectedly must come
// back up on its own (bounded auto-respawn) and/or on the next request (lazy
// re-boot). Before this change, a crashed worker stayed dead until the entire
// host was restarted — one bad deploy's exit was a permanent outage for it.
//
// The seeded capsule crashes exactly once: on first boot it schedules
// process.exit(1) after a short delay and drops a marker file so the second
// boot serves normally. The test asserts (a) the crash actually happened
// (marker present) and (b) the capsule serves again afterwards.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import * as http from "node:http"
import { randomBytes } from "node:crypto"

import { stopProc } from "./proc-kill.mjs"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")

const cleanupDirs = []
const cleanupProcs = []

after(async () => {
  for (const p of cleanupProcs) {
    await stopProc(p, 3000)
  }
  for (const d of cleanupDirs) {
    // maxRetries/retryDelay: Windows can briefly lock a worker's SQLite handle
    // after the host exits, so a bare rmSync races with EBUSY.
    if (existsSync(d)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

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
  throw new Error(`host did not become healthy within ${timeoutMs}ms`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Capsule that kills its own worker once, then serves normally on respawn.
const CRASHING_SERVER_SRC = `import { capsule, query, string, table } from "pond/server"
import { existsSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
const marker = join(process.cwd(), ".pond", "crashed-once")
if (!existsSync(marker)) {
  setTimeout(() => {
    try {
      mkdirSync(join(process.cwd(), ".pond"), { recursive: true })
      writeFileSync(marker, "1")
    } catch {}
    process.exit(1)
  }, 600)
}
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { ping: query(() => "pong") },
  mutations: {},
})
`

test("a capsule that crashes after boot is brought back up (auto-respawn + lazy re-boot)", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "pond-crash-recovery-"))
  cleanupDirs.push(dataDir)
  const publicHost = "localhost"
  const port = await pickFreePort()
  const apiUrl = `http://127.0.0.1:${port}`
  const hostToken = randomBytes(16).toString("hex")

  const proc = spawn(
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
  cleanupProcs.push(proc)
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", () => {})

  await waitForHealth(apiUrl)

  // Bootstrap an admin (admin-owned deploys boot without the network/permission
  // sandbox, so the worker can freely write its crash marker).
  const adminRes = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "admin" }),
  })
  assert.equal(adminRes.status, 201)
  const adminToken = (await adminRes.json()).token

  const deployRes = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      sourceFiles: {
        "server/index.ts": CRASHING_SERVER_SRC,
        "package.json": '{"name":"crash-cap","private":true,"type":"module"}\n',
      },
    }),
  })
  const deployBody = await deployRes.json()
  assert.equal(deployRes.status, 201, `deploy create failed: ${JSON.stringify(deployBody)}`)
  const deployId = deployBody.deployId

  // fetch() forbids setting the `host` header, so use node:http to spoof the
  // subdomain that routes the request to the deploy worker via the proxy.
  const http = await import("node:http")
  const ping = () =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          path: "/api/query/ping",
          headers: { host: `${deployId}.${publicHost}:${port}` },
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

  // Boot 1 is live immediately after deploy create returns.
  const first = await ping()
  assert.equal(first.status, 200, "capsule should serve before its scheduled crash")

  const marker = path.join(dataDir, "deploys", deployId, ".pond", "crashed-once")

  // Wait past the scheduled crash (600ms) + first backoff (500ms) with margin.
  let recovered = false
  const start = Date.now()
  while (Date.now() - start < 8000) {
    await sleep(200)
    if (!existsSync(marker)) continue // crash hasn't fired yet
    try {
      const r = await ping()
      if (r.status === 200 && r.body.includes("pong")) {
        recovered = true
        break
      }
    } catch {
      // worker mid-respawn — keep polling
    }
  }

  assert.ok(existsSync(marker), "the worker should have crashed at least once (marker written)")
  assert.ok(recovered, "the capsule should serve again after crashing (self-healed)")
})

// Capsule that crashes on EVERY boot — it boots far enough to send "booted"
// (so deploy-create succeeds and it enters the restart loop), then exits 200ms
// later. With nothing re-arming it, the host exhausts its restart budget.
const ALWAYS_CRASHING_SERVER_SRC = `import { capsule, query, string, table } from "pond/server"
setTimeout(() => { process.exit(1) }, 200)
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { ping: query(() => "pong") },
  mutations: {},
})
`

test("crash-loop budget exhaustion fires exactly one operator alert + sets crashLoopedAt", async () => {
  // A tiny webhook sink records every alert POST the host sends.
  const alerts = []
  const sink = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      try {
        alerts.push(JSON.parse(body))
      } catch {
        // ignore non-JSON
      }
      res.writeHead(204).end()
    })
  })
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve))
  sink.unref()
  const sinkPort = sink.address().port
  after(() => sink.close())

  const dataDir = mkdtempSync(path.join(tmpdir(), "pond-crash-loop-"))
  cleanupDirs.push(dataDir)
  const publicHost = "localhost"
  const port = await pickFreePort()
  const apiUrl = `http://127.0.0.1:${port}`
  const hostToken = randomBytes(16).toString("hex")

  const proc = spawn(
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
      "--alert-webhook",
      `http://127.0.0.1:${sinkPort}/alert`,
    ],
    {
      env: { ...process.env, POND_HOST_TOKEN: hostToken },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  )
  cleanupProcs.push(proc)
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", () => {})

  await waitForHealth(apiUrl)

  const adminRes = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "admin" }),
  })
  assert.equal(adminRes.status, 201)
  const adminToken = (await adminRes.json()).token

  const deployRes = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      sourceFiles: {
        "server/index.ts": ALWAYS_CRASHING_SERVER_SRC,
        "package.json": '{"name":"loop-cap","private":true,"type":"module"}\n',
      },
    }),
  })
  const deployBody = await deployRes.json()
  assert.equal(deployRes.status, 201, `deploy create failed: ${JSON.stringify(deployBody)}`)
  const deployId = deployBody.deployId

  // Reaching exhaustion takes 6 crashes spaced by the fixed backoff ladder
  // (0.5+1+2+5+10s ≈ 18.5s) plus boot time — poll generously.
  const recordPath = path.join(dataDir, "deploys", deployId, "deploy.json")
  const start = Date.now()
  while (Date.now() - start < 45000) {
    await sleep(500)
    if (alerts.length > 0) break
  }
  assert.ok(alerts.length >= 1, "expected a crash-loop alert webhook POST")

  // Settle: confirm the alert is one-shot (no duplicate within a further window).
  await sleep(3000)
  assert.equal(alerts.length, 1, `expected exactly one alert, got ${alerts.length}`)

  const alert = alerts[0]
  assert.equal(alert.event, "capsule.crash_loop")
  assert.equal(alert.deployId, deployId)
  assert.equal(alert.restarts, 5)
  assert.ok(typeof alert.ts === "string" && alert.ts.length > 0)

  // The machine-readable marker is persisted on the record.
  const record = JSON.parse(readFileSync(recordPath, "utf-8"))
  assert.ok(record.crashLoopedAt, "deploy record should carry crashLoopedAt after exhaustion")
  assert.match(record.bootError ?? "", /crash/i)
})
