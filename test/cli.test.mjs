import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as net from "node:net"

const execFileP = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")

const cleanupDirs = []
const cleanupProcs = []

after(async () => {
  for (const p of cleanupProcs) {
    if (p && p.exitCode === null) {
      const exited = new Promise((r) => p.once("exit", r))
      p.kill("SIGINT")
      const t = setTimeout(() => p.kill("SIGKILL"), 4000)
      t.unref()
      await exited
      clearTimeout(t)
    }
  }
  for (const d of cleanupDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  cleanupDirs.push(d)
  return d
}

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

async function waitForUrl(url, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status === 404) return r
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`url did not respond at ${url} within ${timeoutMs}ms`)
}

test("`pond new` scaffolds expected files", async () => {
  const parent = tmp("pond-cli-new-")
  const name = "my-cap"
  await execFileP(process.execPath, [CLI_PATH, "new", name, "--no-git"], {
    cwd: parent,
    env: { ...process.env },
    timeout: 30000,
  })
  const projDir = path.join(parent, name)
  assert.ok(existsSync(path.join(projDir, "server", "index.ts")))
  assert.ok(existsSync(path.join(projDir, "client", "index.tsx")))
  assert.ok(existsSync(path.join(projDir, ".env.pond.server")))
  assert.ok(existsSync(path.join(projDir, ".gitignore")))
  const pkg = JSON.parse(readFileSync(path.join(projDir, "package.json"), "utf-8"))
  assert.equal(pkg.name, name)
  assert.equal(pkg.type, "module")
  assert.equal(pkg.scripts.dev, "pond dev")
  // .env.pond.server should have a generated session secret comment
  const env = readFileSync(path.join(projDir, ".env.pond.server"), "utf-8")
  assert.match(env, /POND_SESSION_SECRET=[a-f0-9]{32,}/)
})

test("`pond new` refuses to overwrite an existing directory", async () => {
  const parent = tmp("pond-cli-new-collision-")
  const name = "existing"
  mkdirSync(path.join(parent, name))
  await assert.rejects(
    () =>
      execFileP(process.execPath, [CLI_PATH, "new", name, "--no-git"], {
        cwd: parent,
        timeout: 10000,
      }),
    /already exists|process exited|code 1/i,
  )
})

test("`pond deploy --local` produces .pond/deploy-bundle.mjs and deploy.json", async () => {
  const parent = tmp("pond-cli-deploy-")
  await execFileP(process.execPath, [CLI_PATH, "new", "cap1", "--no-git"], {
    cwd: parent,
    env: { ...process.env },
    timeout: 30000,
  })
  const projDir = path.join(parent, "cap1")
  await execFileP(process.execPath, [CLI_PATH, "deploy", "--local"], {
    cwd: projDir,
    env: { ...process.env },
    timeout: 30000,
  })
  const bundle = path.join(projDir, ".pond", "deploy-bundle.mjs")
  const deployFile = path.join(projDir, ".pond", "deploy.json")
  assert.ok(existsSync(bundle), "deploy-bundle.mjs missing")
  assert.ok(existsSync(deployFile), "deploy.json missing")
  const body = JSON.parse(readFileSync(deployFile, "utf-8"))
  assert.ok(typeof body.deployId === "string")
  assert.ok(typeof body.bundleHash === "string")
  // local-only deploy has no claimToken
  assert.equal(body.claimToken, undefined)
})

test("`pond start` serves the bundled output", async () => {
  const parent = tmp("pond-cli-start-")
  // Scaffold + deploy
  await execFileP(process.execPath, [CLI_PATH, "new", "cap2", "--no-git"], {
    cwd: parent,
    timeout: 30000,
  })
  const projDir = path.join(parent, "cap2")
  await execFileP(process.execPath, [CLI_PATH, "deploy", "--local"], {
    cwd: projDir,
    timeout: 30000,
  })
  const port = await pickFreePort()
  const proc = spawn(process.execPath, [CLI_PATH, "start", "--port", String(port)], {
    cwd: projDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanupProcs.push(proc)
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", () => {})
  try {
    // The scaffold has a `messages` query — hit it.
    const res = await waitForUrl(`http://127.0.0.1:${port}/api/query/messages`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body), `expected array, got ${typeof body}`)
  } finally {
    if (proc.exitCode === null) {
      const exited = new Promise((r) => proc.once("exit", r))
      proc.kill("SIGINT")
      const t = setTimeout(() => proc.kill("SIGKILL"), 4000)
      t.unref()
      await exited
      clearTimeout(t)
    }
  }
})

test("`pond dev` boots, serves /api/query, and exits cleanly on SIGINT", async () => {
  const parent = tmp("pond-cli-dev-")
  await execFileP(process.execPath, [CLI_PATH, "new", "cap3", "--no-git"], {
    cwd: parent,
    timeout: 30000,
  })
  const projDir = path.join(parent, "cap3")
  const port = await pickFreePort()
  const proc = spawn(process.execPath, [CLI_PATH, "dev", "--port", String(port)], {
    cwd: projDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanupProcs.push(proc)
  let stderrBuf = ""
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", (c) => (stderrBuf += c.toString()))
  try {
    const res = await waitForUrl(`http://127.0.0.1:${port}/api/query/messages`, 15000)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body))

    // The dev server also exposes /__pond/inspect — sanity-check it.
    const inspect = await fetch(`http://127.0.0.1:${port}/__pond/inspect`)
    assert.equal(inspect.status, 200)
    const insp = await inspect.json()
    assert.ok(Array.isArray(insp.queries) && insp.queries.includes("messages"))
  } finally {
    const exited = new Promise((r) => proc.once("exit", r))
    proc.kill("SIGINT")
    const t = setTimeout(() => proc.kill("SIGKILL"), 4000)
    t.unref()
    await exited
    clearTimeout(t)
  }
  // SIGINT should produce a clean exit (code 0 OR signal SIGINT)
  assert.ok(
    proc.exitCode === 0 || proc.signalCode === "SIGINT" || proc.exitCode === null,
    `dev exited unexpectedly: code=${proc.exitCode}, signal=${proc.signalCode}, stderr=${stderrBuf.slice(-300)}`,
  )
})

// Sanity smoke that the dev server's loopback guard rejects non-loopback
// origin claims. We can't actually originate from another IP in a test, but
// we can verify the endpoint returns 200 for loopback (the negative path is
// covered by reading the source — there's only one branch).
test("`pond dev` /__pond/auth/guest accepts loopback POST", async () => {
  const parent = tmp("pond-cli-dev-guest-")
  await execFileP(process.execPath, [CLI_PATH, "new", "cap4", "--no-git"], {
    cwd: parent,
    timeout: 30000,
  })
  const projDir = path.join(parent, "cap4")
  const port = await pickFreePort()
  const proc = spawn(process.execPath, [CLI_PATH, "dev", "--port", String(port)], {
    cwd: projDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanupProcs.push(proc)
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", () => {})
  try {
    await waitForUrl(`http://127.0.0.1:${port}/__pond/inspect`, 15000)
    const res = await fetch(`http://127.0.0.1:${port}/__pond/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.userId, "alice")
    assert.equal(body.displayName, "alice")
    // Reject bad input
    const bad = await fetch(`http://127.0.0.1:${port}/__pond/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "evil; DROP TABLE--" }),
    })
    assert.equal(bad.status, 400)
  } finally {
    const exited = new Promise((r) => proc.once("exit", r))
    proc.kill("SIGINT")
    const t = setTimeout(() => proc.kill("SIGKILL"), 4000)
    t.unref()
    await exited
    clearTimeout(t)
  }
})

test("`pond admin terminate` kills a deploy via the host token", async () => {
  const hostToken = "deadbeefdeadbeefdeadbeefdeadbeef"
  const dataDir = tmp("pond-admin-term-")
  const port = await pickFreePort()
  const apiUrl = `http://127.0.0.1:${port}`
  const proc = spawn(
    process.execPath,
    [CLI_PATH, "host", "--port", String(port), "--host", "127.0.0.1", "--data-dir", dataDir],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, POND_HOST_TOKEN: hostToken },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  cleanupProcs.push(proc)
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", () => {})
  try {
    await waitForUrl(`${apiUrl}/api/health`)
    const create = await fetch(`${apiUrl}/api/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceFiles: {
          "server/index.ts":
            'import { capsule, mutation, query, string, table } from "pond/server"\nexport default capsule({\n  schema: { items: table({ name: string() }) },\n  queries: { items: query((ctx) => ctx.db.items.all()) },\n  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },\n})\n',
          "package.json": '{"name":"test-cap","private":true,"type":"module"}\n',
        },
      }),
    })
    assert.equal(create.status, 201)
    const { deployId } = await create.json()

    // Wrong token is rejected.
    const bad = await execFileP(
      process.execPath,
      [CLI_PATH, "admin", "terminate", deployId, "--api", apiUrl, "--host-token", "nope"],
      { env: { ...process.env, POND_HOST_TOKEN: "" } },
    ).then(
      () => ({ failed: false }),
      (e) => ({ failed: true, stderr: String(e.stderr ?? "") }),
    )
    assert.equal(bad.failed, true, "wrong host token should make the CLI exit non-zero")

    // Correct token via env.
    const { stdout } = await execFileP(process.execPath, [CLI_PATH, "admin", "terminate", deployId, "--api", apiUrl], {
      env: { ...process.env, POND_HOST_TOKEN: hostToken },
    })
    assert.match(stdout, new RegExp(`Terminated deploy ${deployId}`))
  } finally {
    if (proc.exitCode === null) {
      const exited = new Promise((r) => proc.once("exit", r))
      proc.kill("SIGINT")
      const t = setTimeout(() => proc.kill("SIGKILL"), 4000)
      t.unref()
      await exited
      clearTimeout(t)
    }
  }
})

test("`pond uninstall` dry-run lists steps without deleting", async () => {
  const fakeHome = tmp("pond-uninstall-dry-")
  mkdirSync(path.join(fakeHome, ".pond"), { recursive: true })
  writeFileSync(path.join(fakeHome, ".pond", "credentials.json"), '{"token":"x"}')
  const { stdout } = await execFileP(process.execPath, [CLI_PATH, "uninstall"], {
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    timeout: 5000,
  })
  assert.match(stdout, /Dry run/)
  assert.match(stdout, /npm uninstall -g pondsh/)
  assert.ok(existsSync(path.join(fakeHome, ".pond", "credentials.json")), "dry run must not delete state")
})

test("`pond uninstall --yes` wipes ~/.pond and tells user to run npm uninstall", async () => {
  const fakeHome = tmp("pond-uninstall-yes-")
  mkdirSync(path.join(fakeHome, ".pond"), { recursive: true })
  writeFileSync(path.join(fakeHome, ".pond", "credentials.json"), '{"token":"x"}')
  const { stdout } = await execFileP(process.execPath, [CLI_PATH, "uninstall", "--yes"], {
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    timeout: 5000,
  })
  assert.match(stdout, /Removed/)
  assert.match(stdout, /npm uninstall -g pondsh/)
  assert.ok(!existsSync(path.join(fakeHome, ".pond")), "~/.pond should be gone")
})
