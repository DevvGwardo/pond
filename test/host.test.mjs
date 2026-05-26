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
