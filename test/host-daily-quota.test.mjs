import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as http from "node:http"
import { randomBytes } from "node:crypto"

import { stopProc } from "./proc-kill.mjs"
import { pickFreePort, waitForHealth, TINY_SERVER_SRC, tinySourceFiles } from "./helpers.mjs"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")

let hostProc = null
let dataDir = null
let port = 0
let apiUrl = ""
const publicHost = "localhost"
const hostToken = randomBytes(16).toString("hex")

// Caps kept tiny so the test exercises the boundary in a handful of requests.
const REQ_CAP = 4
const MUT_CAP = 2

async function startHost() {
  port = await pickFreePort()
  apiUrl = `http://127.0.0.1:${port}`
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-host-quota-test-"))
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
      "--anon-requests-per-day",
      String(REQ_CAP),
      "--anon-mutations-per-day",
      String(MUT_CAP),
      // Don't let the per-IP deploy-creation limit interfere (we create 2 anon).
      "--anonymous-rate-per-hour",
      "100",
    ],
    { env: { ...process.env, POND_HOST_TOKEN: hostToken }, stdio: ["ignore", "pipe", "pipe"], cwd: REPO_ROOT },
  )
  hostProc.stdout.on("data", () => {})
  hostProc.stderr.on("data", () => {})
  await waitForHealth(apiUrl)
}

async function stopHost() {
  await stopProc(hostProc)
  hostProc = null
}

async function createAnonDeploy() {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(res.status, 201, "anonymous deploy create should succeed")
  return (await res.json()).deployId
}

// Hit the capsule through the control-plane proxy by spoofing the subdomain
// Host header (fetch to 127.0.0.1 would bypass deployIdFromHost).
function viaProxy(deployId, { method = "GET", path: p = "/api/query/items", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: p,
        headers: {
          host: `${deployId}.${publicHost}:${port}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }))
      },
    )
    req.on("error", reject)
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body))
    req.end()
  })
}

before(async () => {
  await startHost()
})

after(async () => {
  try {
    await stopHost()
  } finally {
    // maxRetries/retryDelay: on Windows a worker child can hold its SQLite handle
    // for a few ms after the host exits, so a bare rmSync races with EBUSY.
    if (dataDir && existsSync(dataDir))
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("anonymous request quota: allows up to the cap, then 429s with Retry-After", async () => {
  const deployId = await createAnonDeploy()
  for (let i = 1; i <= REQ_CAP; i++) {
    const r = await viaProxy(deployId)
    assert.notEqual(r.status, 429, `request ${i} (within cap of ${REQ_CAP}) should not be rate limited`)
  }
  const over = await viaProxy(deployId)
  assert.equal(over.status, 429, `request ${REQ_CAP + 1} should exceed the daily cap`)
  assert.ok(over.headers["retry-after"], "429 should carry a Retry-After header")
  assert.match(JSON.parse(over.body).error, /request/i)
})

test("anonymous mutation quota: counted separately, 429s past the mutation cap", async () => {
  const deployId = await createAnonDeploy()
  for (let i = 1; i <= MUT_CAP; i++) {
    const r = await viaProxy(deployId, { method: "POST", path: "/api/mutation/add", body: { args: [`x${i}`] } })
    assert.notEqual(r.status, 429, `mutation ${i} (within cap of ${MUT_CAP}) should not be rate limited`)
  }
  const over = await viaProxy(deployId, { method: "POST", path: "/api/mutation/add", body: { args: ["over"] } })
  assert.equal(over.status, 429, `mutation ${MUT_CAP + 1} should exceed the daily mutation cap`)
  assert.match(JSON.parse(over.body).error, /mutation/i)
})

test("owned (claimed) deploys are exempt from the anonymous quota", async () => {
  // Bootstrap an admin and create an authenticated deploy; it must never 429
  // even past the anonymous caps.
  const adminRes = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "admin" }),
  })
  const adminToken = (await adminRes.json()).token
  const depRes = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(depRes.status, 201)
  const deployId = (await depRes.json()).deployId
  for (let i = 0; i < REQ_CAP + 3; i++) {
    const r = await viaProxy(deployId)
    assert.notEqual(r.status, 429, "owned deploy should never be quota-limited")
  }
})
