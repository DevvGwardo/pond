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
    [CLI_PATH, "host", "--port", String(port), "--host", "127.0.0.1", "--public-host", publicHost, "--data-dir", dataDir, "--anonymous-rate-per-hour", "100"],
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

test("failed anonymous boot cleans up dir + DB rows (regression)", async () => {
  const fs = await import("node:fs")
  // 'QQ==' base64-decodes to 'A' — a 1-byte invalid bundle that fails on import.
  // Use an extra host so the rate-limit window is fresh.
  const h = await startExtraHost()
  try {
    const before = fs.readdirSync(path.join(h.dataDir, "deploys")).length
    const res = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleBase64: "QQ==" }),
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
    [CLI_PATH, "host", "--port", String(xPort), "--host", "127.0.0.1", "--public-host", publicHost, "--data-dir", xData, ...extraArgs],
    {
      env: { ...process.env, POND_HOST_TOKEN: xToken, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    }
  )
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", () => {})
  await waitForHealth(xUrl)
  return { proc, port: xPort, apiUrl: xUrl, dataDir: xData, hostToken: xToken }
}

async function stopExtraHost(h) {
  if (h.proc && h.proc.exitCode === null) {
    const exited = new Promise((resolve) => h.proc.once("exit", resolve))
    h.proc.kill("SIGINT")
    const t = setTimeout(() => {
      if (h.proc.exitCode === null) h.proc.kill("SIGKILL")
    }, 4000)
    t.unref()
    await exited
    clearTimeout(t)
  }
  if (h.dataDir && existsSync(h.dataDir)) rmSync(h.dataDir, { recursive: true, force: true })
}

async function buildBundleWith(workDir, serverSrc) {
  const serverFile = path.join(workDir, "server", "index.ts")
  mkdirSync(path.dirname(serverFile), { recursive: true })
  writeFileSync(serverFile, serverSrc)
  const { outfile } = await buildForDeploy(serverFile, workDir)
  return outfile
}

let anonDeployId = ""
let anonClaimToken = ""

test("anonymous POST /api/deploys succeeds and returns terminatesAt + expiresAt", async () => {
  const fs = await import("node:fs")
  const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundleBase64 }),
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

test("anonymous quota rejects > 16 MB bundle with 413", async () => {
  // 17 MB of random bytes, base64-encoded inside JSON. Total request body
  // ends up ~23 MB which is under the 64 MB outer body limit but should be
  // rejected by the anonymous 16 MB bundle quota.
  const bigBuf = Buffer.alloc(17 * 1024 * 1024, 0x42)
  const bundleBase64 = bigBuf.toString("base64")
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundleBase64 }),
  })
  assert.equal(res.status, 413)
})

test("anonymous PUT /api/deploys/:id returns 403", async () => {
  const fs = await import("node:fs")
  const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
  const res = await fetch(`${apiUrl}/api/deploys/${anonDeployId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-pond-claim-token": anonClaimToken,
    },
    body: JSON.stringify({ bundleBase64 }),
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

test("claim with --signup creates user and transfers ownership", async () => {
  // Deploy anonymously, then claim with signup.
  const fs = await import("node:fs")
  const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundleBase64 }),
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
  const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundleBase64 }),
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

test("anonymous rate limit: 6th request from same IP in an hour returns 429", async () => {
  const h = await startExtraHost({ extraArgs: ["--anonymous-rate-per-hour", "5"] })
  try {
    const fs = await import("node:fs")
    const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
    const statuses = []
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${h.apiUrl}/api/deploys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleBase64 }),
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
      [CLI_PATH, "host", "--port", String(xPort), "--host", "127.0.0.1", "--public-host", publicHost, "--data-dir", xData, "--anonymous-rate-per-hour", "3"],
      {
        env: { ...process.env, POND_HOST_TOKEN: xToken },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
      }
    )
  }
  async function killHost(p) {
    if (p && p.exitCode === null) {
      const exited = new Promise((r) => p.once("exit", r))
      p.kill("SIGINT")
      const t = setTimeout(() => p.kill("SIGKILL"), 4000)
      t.unref()
      await exited
      clearTimeout(t)
    }
  }
  let p1 = spawnHost()
  p1.stdout.on("data", () => {})
  p1.stderr.on("data", () => {})
  try {
    await waitForHealth(xUrl)
    const fs2 = await import("node:fs")
    const bundleBase64 = fs2.readFileSync(bundlePath).toString("base64")
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${xUrl}/api/deploys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleBase64 }),
      })
      await res.text().catch(() => "")
      assert.equal(res.status, 201, `attempt ${i + 1} should succeed`)
    }
    // 4th hits the in-process limiter
    const limited = await fetch(`${xUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleBase64 }),
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
      body: JSON.stringify({ bundleBase64 }),
    })
    await afterRestart.text().catch(() => "")
    assert.equal(afterRestart.status, 429, "rate limit must persist across host restart")
  } finally {
    await killHost(p1)
    if (existsSync(xData)) rmSync(xData, { recursive: true, force: true })
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
      [CLI_PATH, "host", "--port", String(tinyPort), "--host", "127.0.0.1", "--public-host", publicHost, "--data-dir", tinyData],
      {
        env: { ...process.env, POND_HOST_TOKEN: tinyToken, POND_ANONYMOUS_CLEANUP_GRACE: "1s", POND_ANONYMOUS_CLEANUP_RETENTION: "300s" },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
      }
    )
  }
  let p1 = spawnTiny()
  p1.stdout.on("data", () => {})
  p1.stderr.on("data", () => {})
  try {
    await waitForHealth(tinyApi)
    const fs = await import("node:fs")
    const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
    const res = await fetch(`${tinyApi}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleBase64 }),
    })
    assert.equal(res.status, 201)
    const cb = await res.json()

    // Wait so grace passes.
    await new Promise((r) => setTimeout(r, 2000))

    // Bounce: SIGINT old host, start a new one. Startup runs runSweep() before
    // listening, which marks terminated and skips booting the terminated worker.
    const exited = new Promise((r) => p1.once("exit", r))
    p1.kill("SIGINT")
    const t = setTimeout(() => p1.kill("SIGKILL"), 4000)
    t.unref()
    await exited
    clearTimeout(t)

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
        }
      )
      req.on("error", () => resolve({ status: 0 }))
      req.end()
    })
    assert.equal(probe.status, 404, `expected 404 (terminated), got ${probe.status} body=${probe.body}`)
  } finally {
    if (p1 && p1.exitCode === null) {
      const exited = new Promise((r) => p1.once("exit", r))
      p1.kill("SIGINT")
      const t = setTimeout(() => p1.kill("SIGKILL"), 4000)
      t.unref()
      await exited
      clearTimeout(t)
    }
    if (existsSync(tinyData)) rmSync(tinyData, { recursive: true, force: true })
  }
})

test("anonymous-deploys=false → anonymous POST returns 401", async () => {
  const h = await startExtraHost({ extraArgs: ["--anonymous-deploys", "false"] })
  try {
    const fs = await import("node:fs")
    const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
    const res = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleBase64 }),
    })
    assert.equal(res.status, 401)
  } finally {
    await stopExtraHost(h)
  }
})

test("Node 22+ permission model: anonymous worker cannot write outside deploy dir", { skip: parseInt(process.versions.node.split(".")[0], 10) < 22 ? "requires Node 22+" : false }, async () => {
  // Capsule whose mutation tries to write to /tmp/pond-escape-test.
  const escapeWorkDir = mkdtempSync(path.join(tmpdir(), "pond-cap-escape-"))
  const escapeFile = path.join(tmpdir(), `pond-escape-${randomBytes(4).toString("hex")}.txt`)
  try {
    const bundle = await buildBundleWith(
      escapeWorkDir,
      `import { capsule, mutation, query, string, table } from "pond/server"
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
`
    )
    const fs = await import("node:fs")
    const bundleBase64 = fs.readFileSync(bundle).toString("base64")
    const create = await fetch(`${apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleBase64 }),
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
        }
      )
      req.on("error", reject)
      req.write(payload)
      req.end()
    })
    // Either mutation reports ok:false with ERR_ACCESS_DENIED, or the file was never created.
    const exists = fs.existsSync(escapeFile)
    assert.equal(exists, false, `escape file should not exist: ${escapeFile} body=${result.body}`)
  } finally {
    if (existsSync(escapeFile)) rmSync(escapeFile, { force: true })
    if (existsSync(escapeWorkDir)) rmSync(escapeWorkDir, { recursive: true, force: true })
  }
})

async function createOwnedDeploy() {
  const fs = await import("node:fs")
  const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
  const res = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ bundleBase64 }),
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
      { host: "127.0.0.1", port, method: "GET", path: "/api/query/items", headers: { host: `abcdef12.${publicHost}:${port}` } },
      (res) => resolve({ status: res.statusCode })
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
      }
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
  const bundleBase64 = fs.readFileSync(bundlePath).toString("base64")
  const dep = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${carol.token}` },
    body: JSON.stringify({ bundleBase64 }),
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
      }
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
  const bundleBase64 = fs2.readFileSync(bundlePath).toString("base64")
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ bundleBase64 }),
  })
  const cb = await create.json()
  const res = await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: "not json",
  })
  assert.equal(res.status, 400)
  // Cleanup
  await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } })
})

test("PUT /api/deploys/:id/quota with no fields → 400 (not silent 200) [B4]", async () => {
  const fs2 = await import("node:fs")
  const bundleBase64 = fs2.readFileSync(bundlePath).toString("base64")
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ bundleBase64 }),
  })
  const cb = await create.json()
  const res = await fetch(`${apiUrl}/api/deploys/${cb.deployId}/quota`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
  await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } })
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
  const bundleBase64 = fs2.readFileSync(bundlePath).toString("base64")
  const dRes = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ bundleBase64 }),
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
  // Skip on Node < 22 only because sandbox flags need it — but the fetch/net shim
  // is independent of Node version and should work on 20 too. So we always run.
  const fs2 = await import("node:fs")
  // Build a tiny bundle that tries to connect to 1.1.1.1:80 via https.request.
  const escapeBundle = `
import * as https from "node:https"
const results = []
try {
  await new Promise((res, rej) => {
    const req = https.request({host:"1.1.1.1",port:443,method:"GET",path:"/"}, () => res())
    req.on("error", rej)
    req.end()
    setTimeout(()=>rej(new Error("timeout")), 1500)
  })
  results.push("https:OK")
} catch (e) { results.push("https:" + (e.message || e.code)) }
console.error("B2RESULT:" + JSON.stringify(results))
export default { schema: {}, queries: {}, mutations: {} }
`
  // Write to a tmpfile and base64 it
  const tmpFile = path.join(workDir, "b2-bundle.mjs")
  fs2.writeFileSync(tmpFile, escapeBundle)
  const bundleBase64 = fs2.readFileSync(tmpFile).toString("base64")

  // Spin a host with rate limit high enough.
  const h = await startExtraHost({ extraArgs: ["--anonymous-rate-per-hour", "100"] })
  try {
    // Capture stderr from the extra host to read B2RESULT.
    let stderrBuf = ""
    h.proc.stderr.on("data", (c) => (stderrBuf += c.toString()))
    const res = await fetch(`${h.apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleBase64 }),
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

// ---- envText size caps ----

test("PUT /api/deploys/:id rejects envText > 64KB with 413", async () => {
  const fs2 = await import("node:fs")
  const bundleBase64 = fs2.readFileSync(bundlePath).toString("base64")
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ bundleBase64 }),
  })
  assert.equal(create.status, 201)
  const cb = await create.json()
  try {
    // 65 KB envText, well over the 64 KB cap
    const envText = `FOO=${"x".repeat(65 * 1024)}\n`
    const res = await fetch(`${apiUrl}/api/deploys/${cb.deployId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ bundleBase64, envText }),
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
  const bundleBase64 = fs2.readFileSync(bundlePath).toString("base64")
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ bundleBase64 }),
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
  const bundleBase64 = fs2.readFileSync(bundlePath).toString("base64")
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundleBase64 }),
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
    u.userId
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
  const bundleBase64 = fs2.readFileSync(bundlePath).toString("base64")
  const create = await fetch(`${apiUrl}/api/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ bundleBase64 }),
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
  const creation = body.entries.find(
    (e) => e.action === "deploy.create" && e.targetDeployId === cb.deployId
  )
  assert.ok(creation, `expected deploy.create entry for ${cb.deployId}, got ${JSON.stringify(body.entries.slice(0, 5))}`)
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
    const bundleBase64 = fs2.readFileSync(bundlePath).toString("base64")
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
      body: JSON.stringify({ bundleBase64 }),
    })
    assert.equal(dep.status, 201)
    const cb = await dep.json()

    const auditRes = await fetch(`${h.apiUrl}/api/audit`, {
      headers: { authorization: `Bearer ${ba.token}` },
    })
    assert.equal(auditRes.status, 200)
    const body = await auditRes.json()
    const entry = body.entries.find(
      (e) => e.action === "deploy.create" && e.targetDeployId === cb.deployId
    )
    assert.ok(entry, "expected anon deploy.create audit entry")
    assert.equal(entry.actor, "__anonymous__")
    assert.equal(entry.metadata?.anonymous, true)
  } finally {
    await stopExtraHost(h)
  }
})

test("pond deploy writes .pond/deploy.json with mode 0600 (hosted path)", { skip: process.platform === "win32" ? "POSIX modes only" : false }, async () => {
  // Stage a capsule project in a tmpdir, then invoke the CLI to deploy
  // anonymously against the running test host.
  const projDir = mkdtempSync(path.join(tmpdir(), "pond-deploy-perm-"))
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
`
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
    // POSIX mode lower 9 bits — we want 0600 (rw-------).
    assert.equal(st.mode & 0o777, 0o600, `expected 0600, got 0${(st.mode & 0o777).toString(8)}`)
    // sanity: file contains a claimToken
    const body = JSON.parse(readFileSync(deployFile, "utf-8"))
    assert.ok(typeof body.claimToken === "string" && body.claimToken.length >= 32)
    // Cleanup the host-side deploy
    await fetch(`${apiUrl}/api/deploys/${body.deployId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    })
  } finally {
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true })
  }
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
