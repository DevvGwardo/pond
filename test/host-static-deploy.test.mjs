// E2E for the static-deploy path (Lever 1): a capsule({ static: true }) deploy
// is served as its prebuilt client.html straight from the host and NEVER boots
// a worker. Proven end-to-end by:
//   - create returns isStatic: true and persists it on the record
//   - GET / on the subdomain serves the client HTML (no proxy upstream exists)
//   - GET /api/* on the subdomain 404s (a static deploy has no server)
//   - /metrics reports pond_host_capsules_active 0 — i.e. no process was forked
//   - static: true WITHOUT a client/index.tsx is rejected at build time

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { randomBytes } from "node:crypto"

import { stopProc } from "./proc-kill.mjs"
import { pickFreePort, waitForHealth } from "./helpers.mjs"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")
const MARKER = "POND_STATIC_E2E_MARKER"

const STATIC_SERVER_SRC = `import { capsule } from "pond/server"
export default capsule({
  static: true,
  schema: {},
  queries: {},
  mutations: {},
})
`
const STATIC_CLIENT_SRC = `export function App() {
  return <main><h1>${MARKER}</h1></main>
}
`

function staticSourceFiles() {
  return {
    "server/index.ts": STATIC_SERVER_SRC,
    "client/index.tsx": STATIC_CLIENT_SRC,
    "package.json": '{"name":"static-cap","private":true,"type":"module"}\n',
  }
}

// GET against the host with an explicit Host header so the deploy-subdomain
// routing branch is exercised (a bare 127.0.0.1 request would not be).
async function getViaHost(hostHeader, reqPath) {
  const http = await import("node:http")
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: reqPath, headers: { host: hostHeader } },
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

let hostProc = null
let dataDir = null
let port = 0
let apiUrl = ""
const publicHost = "localhost"
const hostToken = randomBytes(16).toString("hex")
let deployId = ""

before(async () => {
  port = await pickFreePort()
  apiUrl = `http://127.0.0.1:${port}`
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-static-test-"))
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
})

after(async () => {
  try {
    await stopProc(hostProc)
    hostProc = null
  } finally {
    if (dataDir && existsSync(dataDir))
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("POST /api/deploys with static:true + client returns isStatic and persists it", async () => {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceFiles: staticSourceFiles() }),
  })
  const text = await res.text()
  assert.equal(res.status, 201, `create failed: ${text}`)
  const body = JSON.parse(text)
  assert.equal(body.isStatic, true, "create response should report isStatic: true")
  assert.ok(body.deployId && body.deployId.length >= 8)
  deployId = body.deployId

  // The persisted record must carry isStatic so the serving path can short-circuit.
  const recPath = path.join(dataDir, "deploys", deployId, "deploy.json")
  assert.ok(existsSync(recPath), `deploy.json missing at ${recPath}`)
  const rec = JSON.parse(readFileSync(recPath, "utf-8"))
  assert.equal(rec.isStatic, true, "persisted record should have isStatic: true")
})

test("static deploy serves its client HTML on the subdomain with no worker", async () => {
  const r = await getViaHost(`${deployId}.${publicHost}:${port}`, "/")
  assert.equal(r.status, 200)
  assert.match(r.ct, /text\/html/)
  assert.match(r.body, /<!doctype html>/i)
  assert.match(r.body, new RegExp(MARKER), "client HTML should include the app marker")
})

test("static deploy SPA-falls back: an arbitrary non-/api path still serves the client", async () => {
  const r = await getViaHost(`${deployId}.${publicHost}:${port}`, "/some/deep/route")
  assert.equal(r.status, 200)
  assert.match(r.body, new RegExp(MARKER))
})

test("static deploy has no server: /api/* returns 404", async () => {
  const r = await getViaHost(`${deployId}.${publicHost}:${port}`, "/api/query/anything")
  assert.equal(r.status, 404)
  assert.match(r.body, /static deploy/i)
})

test("NO capsule worker was forked for the static deploy (pond_host_capsules_active 0)", async () => {
  // The whole point of Lever 1: a static deploy consumes zero capsule slots.
  const res = await fetch(`${apiUrl}/metrics`, { headers: { authorization: `Bearer ${hostToken}` } })
  assert.equal(res.status, 200, `metrics fetch failed: ${res.status}`)
  const text = await res.text()
  assert.match(text, /pond_host_capsules_active 0\b/, `expected 0 active capsules, got:\n${text}`)
  // And the static deploy is not in the per-capsule "up" series at all.
  assert.doesNotMatch(text, new RegExp(`pond_capsule_up\\{deploy="${deployId}"\\}`))
})

test("static:true WITHOUT a client/index.tsx is rejected at build time", async () => {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceFiles: {
        "server/index.ts": STATIC_SERVER_SRC,
        "package.json": '{"name":"static-noclient","private":true,"type":"module"}\n',
      },
    }),
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /requires a client\/index\.tsx/i)
})
