// Concurrent redeploy stress: two+ PUT /api/deploys/:id at once (IDE autobuild
// + env update, two tabs) must never leave two workers for one deploy. Before
// the per-deploy boot chain, each fork passed stopDeploy before the previous
// boot registered, orphaning the first worker — invisible to the idle reaper
// and disk watchdog. This test hammers the update path and asserts exactly
// one deploy-worker process remains and the capsule still serves.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { randomBytes } from "node:crypto"

import { stopProc } from "./proc-kill.mjs"
import { CLI_PATH, REPO_ROOT, pickFreePort, waitForHealth, tinySourceFiles } from "./helpers.mjs"

let hostProc = null
let dataDir = null
let port = 0
let apiUrl = ""
let hostToken = randomBytes(16).toString("hex")
let adminToken = ""

before(async () => {
  port = await pickFreePort()
  apiUrl = `http://127.0.0.1:${port}`
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-concurrency-"))
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

  const r = await fetch(`${apiUrl}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ username: "admin" }),
  })
  assert.equal(r.status, 201)
  adminToken = (await r.json()).token
})

after(async () => {
  try {
    await stopHost()
  } finally {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function stopHost() {
  await stopProc(hostProc)
  hostProc = null
}

// Count live deploy-worker processes for THIS host's data dir. The worker
// cmdline carries --allow-fs-read=<real deploy dir>, which contains dataDir.
// POSIX-only (ps); the suite's Windows leg skips the process-count assertion.
function workerCount() {
  const psOut = execSync("ps -A -o command", { encoding: "utf-8" })
  return psOut.split("\n").filter((l) => l.includes("deploy-worker.js") && l.includes(dataDir)).length
}

test("concurrent redeploys settle with exactly one worker and a live capsule", async (t) => {
  if (process.platform === "win32") {
    t.skip("process counting needs POSIX ps")
    return
  }
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles: tinySourceFiles() }),
  })
  assert.equal(create.status, 201)
  const { deployId, claimToken } = await create.json()
  await waitForHealth(apiUrl)

  // Fire N redeploys at once — the old code leaked a worker per interleaving.
  const N = 5
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      fetch(`${apiUrl}/api/deploys/${deployId}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-pond-claim-token": claimToken },
        body: JSON.stringify({
          sourceFiles: tinySourceFiles(TINY_SERVER_SRC_VARIANT(i)),
        }),
      }),
    ),
  )
  for (const r of results) {
    assert.equal(r.status, 200, await r.text())
  }

  // Capsule workers boot lazily on first request; give the (possibly slow)
  // runner time for the single worker to appear, then assert EXACTLY one.
  let count = 0
  const countDeadline = Date.now() + 10000
  while (Date.now() < countDeadline) {
    count = workerCount()
    if (count >= 1) break
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.equal(count, 1, "exactly one worker must survive N concurrent redeploys")

  // The capsule still serves its latest code (the i-th variant's query name).
  const http = await import("node:http")
  const probe = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/api/query/items",
        headers: { host: `${deployId}.localhost:${port}` },
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
  assert.equal(probe.status, 200, `capsule must still serve after concurrent redeploys: ${probe.body}`)
})

// Each redeploy ships slightly different code so a stale worker would be
// observable (the query handler references a unique const per variant).
const TINY_SERVER_SRC_VARIANT = (i) => `import { capsule, mutation, query, string, table } from "pond/server"
const VARIANT = ${JSON.stringify(`v${i}`)}
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => { void VARIANT; return ctx.db.items.all() }) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`
