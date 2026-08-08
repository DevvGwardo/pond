// End-to-end validation of the symlink hardening: a capsule has read/write
// access to its own deploy dir, so it can plant symlinks there. Every host
// file operation on that dir must refuse to follow a link that escapes it —
// otherwise the capsule could read host-token or a sibling's env, or redirect
// a host write onto deploy-worker.js (RCE as the host user).
//
// The test simulates the capsule's capability directly (writing symlinks into
// the deploy dir — the same thing a running worker can do via
// --allow-fs-write=<deployDir>) and then exercises every host read/write path
// that touches tenant-controlled files.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, lstatSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { randomBytes } from "node:crypto"

import { stopProc } from "./proc-kill.mjs"
import { CLI_PATH, REPO_ROOT, TINY_SERVER_SRC, pickFreePort, waitForHealth, tinySourceFiles } from "./helpers.mjs"

let hostProc = null
let dataDir = null
let port = 0
let apiUrl = ""
let hostToken = ""
let adminToken = ""

// The real host token, as persisted by the host on first boot (no
// POND_HOST_TOKEN env so the file genuinely exists — that file is the attack
// target).
const deployDirFor = (id) => path.join(dataDir, "deploys", id)
const hostTokenFile = () => path.join(dataDir, "host-token")

async function startHost() {
  port = await pickFreePort()
  apiUrl = `http://127.0.0.1:${port}`
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-symlink-host-"))
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
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  )
  let stdoutBuf = ""
  hostProc.stdout.on("data", (c) => (stdoutBuf += c.toString()))
  hostProc.stderr.on("data", () => {})
  await waitForHealth(apiUrl)
  // The first-run banner prints the generated host token exactly once.
  const m = stdoutBuf.match(/host token \(bootstrap \/ recovery, generated now\): ([0-9a-f]{64})/)
  assert.ok(m, "host did not print the generated host token:\n" + stdoutBuf)
  hostToken = m[1]
  assert.ok(existsSync(hostTokenFile()), "host-token file must exist on disk")
}

async function stopHost() {
  await stopProc(hostProc)
  hostProc = null
}

async function createDeploy(sourceFiles) {
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ sourceFiles }),
  })
  if (res.status !== 201) {
    assert.fail(`create deploy failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}

// GET a deploy file with claim-token auth (what the IDE does).
async function getFile(deployId, claimToken, rel) {
  const r = await fetch(`${apiUrl}/api/deploys/${deployId}/files/${rel}`, {
    headers: { "x-pond-claim-token": claimToken },
  })
  return { status: r.status, text: await r.text().catch(() => "") }
}

// From deployDir/source/server, a symlink pointing at dataDir/host-token:
// source/server is 2 levels below the deploy dir, and the deploy dir is 2
// levels below the data dir → 4 levels up.
const HOST_TOKEN_REL = "../../../../host-token"

before(async () => {
  await startHost()
  // Bootstrap an admin via the host token, then create an owned deploy.
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

test("tenant symlink cannot read host-token through the files API", async () => {
  const { deployId, claimToken } = await createDeploy(tinySourceFiles())
  const dir = deployDirFor(deployId)
  const tokenBefore = readFileSync(hostTokenFile(), "utf8")

  // Plant the symlink exactly where the capsule would: inside its own source tree.
  symlinkSync(HOST_TOKEN_REL, path.join(dir, "source", "server", "leak.ts"))

  const got = await getFile(deployId, claimToken, "server/leak.ts")
  assert.equal(got.status, 404, "symlinked read must be refused, not followed")
  assert.ok(!got.text.includes(tokenBefore.trim()), "host-token content must not leak")
  // The tree listing must not leak the symlink's target either.
  const listing = await fetch(`${apiUrl}/api/deploys/${deployId}/files`, {
    headers: { "x-pond-claim-token": claimToken },
  })
  const { files } = await listing.json()
  assert.ok(!files.some((f) => f.path === "server/leak.ts"), "symlinks are not listed as editable files")
})

test("tenant symlink cannot redirect a host write onto host-token (files PUT)", async () => {
  const { deployId, claimToken } = await createDeploy(tinySourceFiles())
  const dir = deployDirFor(deployId)
  const tokenBefore = readFileSync(hostTokenFile(), "utf8")

  symlinkSync(HOST_TOKEN_REL, path.join(dir, "source", "server", "overwrite.ts"))
  const r = await fetch(`${apiUrl}/api/deploys/${deployId}/files/server/overwrite.ts`, {
    method: "PUT",
    headers: { "x-pond-claim-token": claimToken, "content-type": "text/plain" },
    body: "PWNED",
  })
  assert.equal(r.status, 200, await r.text())
  // The symlink must have been REPLACED by a regular file; the token untouched.
  assert.equal(readFileSync(hostTokenFile(), "utf8"), tokenBefore, "host-token must not be overwritten")
  assert.ok(lstatSync(path.join(dir, "source", "server", "overwrite.ts")).isFile(), "symlink replaced by real file")
  assert.equal(readFileSync(path.join(dir, "source", "server", "overwrite.ts"), "utf8"), "PWNED")
})

test("tenant symlink at client.html cannot redirect a redeploy write onto deploy-worker.js", async () => {
  const { deployId, claimToken } = await createDeploy(tinySourceFiles())
  const dir = deployDirFor(deployId)
  const workerFile = path.join(REPO_ROOT, "src", "host", "deploy-worker.js")
  const workerBefore = readFileSync(workerFile, "utf8")
  const sourceFiles = tinySourceFiles()
  sourceFiles["client/index.tsx"] = "export const App = () => null\n"

  // The capsule knows this path (it ships in the same package the host runs).
  symlinkSync(workerFile, path.join(dir, "client.html"))
  const r = await fetch(`${apiUrl}/api/deploys/${deployId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-pond-claim-token": claimToken },
    body: JSON.stringify({ sourceFiles }),
  })
  assert.equal(r.status, 200, await r.text())
  assert.equal(readFileSync(workerFile, "utf8"), workerBefore, "deploy-worker.js must not be overwritten")
  assert.ok(lstatSync(path.join(dir, "client.html")).isFile(), "client.html symlink replaced by the real bundle")
})

test("tenant symlink at .env.pond.server cannot redirect env writes onto host-token", async () => {
  const { deployId } = await createDeploy(tinySourceFiles())
  const dir = deployDirFor(deployId)
  const tokenBefore = readFileSync(hostTokenFile(), "utf8")

  // The capsule deletes its own env file first, then plants the symlink.
  rmSync(path.join(dir, ".env.pond.server"))
  symlinkSync(HOST_TOKEN_REL, path.join(dir, ".env.pond.server"))
  const r = await fetch(`${apiUrl}/api/deploys/${deployId}/env`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ entries: { FOO: "bar" } }),
  })
  assert.equal(r.status, 200, await r.text())
  assert.equal(readFileSync(hostTokenFile(), "utf8"), tokenBefore, "host-token must not be overwritten via env")
  const envNow = readFileSync(path.join(dir, ".env.pond.server"), "utf8")
  assert.ok(envNow.includes("FOO=bar"), "env file is now a regular file with the written entry")
  assert.ok(!envNow.includes(tokenBefore.trim()), "env file must not contain the host token")
})

test("a symlinked deploy.json degrades to 404s and never crashes the host", async () => {
  const { deployId } = await createDeploy(tinySourceFiles())
  const dir = deployDirFor(deployId)

  // The capsule deletes its own record first, then plants the symlink.
  rmSync(path.join(dir, "deploy.json"))
  symlinkSync(HOST_TOKEN_REL, path.join(dir, "deploy.json"))
  const r = await fetch(`${apiUrl}/api/deploys/${deployId}/env`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(r.status, 404, "record behind a symlink must read as missing")
  assert.equal(readFileSync(hostTokenFile(), "utf8").length, 64, "host-token untouched")
  // The host must still be fully alive.
  const health = await fetch(`${apiUrl}/api/health`)
  assert.equal(health.status, 200)
})

test("corrupt deploy.json cannot crash the host (listing, WS upgrade, new deploys)", async () => {
  const { deployId } = await createDeploy(tinySourceFiles())
  // Simulate a capsule truncating/corrupting its own record mid-write.
  writeFileSync(path.join(deployDirFor(deployId), "deploy.json"), "{ not json !!!")

  // Admin listing must tolerate the bad record.
  const listing = await fetch(`${apiUrl}/api/deploys`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  assert.equal(listing.status, 200, "deploys listing must tolerate corrupt records")
  // The raw WebSocket upgrade path (synchronous readRecord) must not throw.
  const http = await import("node:http")
  await new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/",
        headers: {
          host: `${deployId}.localhost:${port}`,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": Buffer.from("pond-ws-upgrade-test-key").toString("base64"),
          "sec-websocket-version": "13",
        },
      },
      (res) => {
        res.resume()
        res.on("end", resolve)
      },
    )
    req.on("error", resolve)
    req.end()
  })
  // Host survived: health + a brand-new deploy still work.
  assert.equal((await fetch(`${apiUrl}/api/health`)).status, 200)
  const fresh = await createDeploy(tinySourceFiles())
  assert.ok(fresh.deployId)
})

test("public source endpoint cannot leak host files through symlinks", async () => {
  const publicSrc = `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  public: true,
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`
  const { deployId } = await createDeploy(tinySourceFiles(publicSrc))
  const dir = deployDirFor(deployId)
  const tokenBefore = readFileSync(hostTokenFile(), "utf8")

  symlinkSync(HOST_TOKEN_REL, path.join(dir, "source", "server", "leak.ts"))
  const r = await fetch(`${apiUrl}/api/public-deploys/${deployId}/source`)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.ok(!("server/leak.ts" in body.files), "symlink must be skipped in the public source walk")
  assert.ok(!JSON.stringify(body).includes(tokenBefore.trim()), "host-token content must not leak")
  // Sibling env files are equally off-limits through the public walk.
  const sibling = await createDeploy(tinySourceFiles())
  writeFileSync(path.join(deployDirFor(sibling.deployId), ".env.pond.server"), "POND_SESSION_SECRET=sibling-secret\n")
  symlinkSync(
    path.relative(path.join(dir, "source", "server"), path.join(deployDirFor(sibling.deployId), ".env.pond.server")),
    path.join(dir, "source", "server", "sibling-env.ts"),
  )
  const r2 = await fetch(`${apiUrl}/api/public-deploys/${deployId}/source`)
  const body2 = await r2.json()
  assert.ok(!JSON.stringify(body2).includes("sibling-secret"), "sibling env must not leak through the public walk")
})

test("sibling env files cannot be read through a relative symlink (files API)", async () => {
  const a = await createDeploy(tinySourceFiles())
  const b = await createDeploy(tinySourceFiles())
  writeFileSync(path.join(deployDirFor(b.deployId), ".env.pond.server"), "POND_SESSION_SECRET=sibling-secret\n")
  // source/server → ../../<b>/.env.pond.server
  const target = path.join(deployDirFor(b.deployId), ".env.pond.server")
  const rel = path.relative(path.join(deployDirFor(a.deployId), "source", "server"), target)
  symlinkSync(rel, path.join(deployDirFor(a.deployId), "source", "server", "sibling-env.ts"))
  const got = await getFile(a.deployId, a.claimToken, "server/sibling-env.ts")
  assert.equal(got.status, 404)
  assert.ok(!got.text.includes("sibling-secret"), "sibling env must not leak")
})
