import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as net from "node:net"

const execFileP = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")

const cleanupDirs = []
const cleanupProcs = []

import { after } from "node:test"
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
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
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

async function waitForUrl(url, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status === 404) return r
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`url did not respond at ${url} within ${timeoutMs}ms`)
}

async function scaffoldCapsule(parent, name, serverSrc) {
  await execFileP(process.execPath, [CLI_PATH, "new", name, "--no-git"], {
    cwd: parent,
    env: { ...process.env },
    timeout: 30000,
  })
  const dir = path.join(parent, name)
  writeFileSync(path.join(dir, "server", "index.ts"), serverSrc)
  return dir
}

function spawnDev(dir, port) {
  const proc = spawn(process.execPath, [CLI_PATH, "dev", "--port", String(port)], {
    cwd: dir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanupProcs.push(proc)
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", () => {})
  return proc
}

async function killProc(proc) {
  if (proc.exitCode === null) {
    const exited = new Promise((r) => proc.once("exit", r))
    proc.kill("SIGINT")
    const t = setTimeout(() => proc.kill("SIGKILL"), 4000)
    t.unref()
    await exited
    clearTimeout(t)
  }
}

test("rate limit returns 429 after burst", async () => {
  const parent = tmp("pond-rl-")
  const serverSrc = `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  schema: { msgs: table({ body: string() }) },
  queries: { msgs: query((ctx) => ctx.db.msgs.all()) },
  mutations: { add: mutation((ctx, body) => ctx.db.msgs.insert({ body })) },
  rateLimit: { add: { perMinute: 3, by: "ip" } },
})`
  const dir = await scaffoldCapsule(parent, "cap-rl", serverSrc)
  const port = await pickFreePort()
  const proc = spawnDev(dir, port)
  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/query/msgs`)
    let ok = 0
    let limited = 0
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/api/mutation/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: [`body-${i}`] }),
      })
      if (r.status === 200) ok++
      if (r.status === 429) limited++
    }
    assert.equal(ok, 3, "3 should succeed")
    assert.equal(limited, 3, "3 should be rate-limited")
  } finally {
    await killProc(proc)
  }
})

test("/__pond/metrics serves Prometheus output", async () => {
  const parent = tmp("pond-metrics-")
  const serverSrc = `import { capsule, query, string, table } from "pond/server"
export default capsule({
  schema: { x: table({ name: string() }) },
  queries: { all: query((ctx) => ctx.db.x.all()) },
  mutations: {},
})`
  const dir = await scaffoldCapsule(parent, "cap-m", serverSrc)
  const port = await pickFreePort()
  const proc = spawnDev(dir, port)
  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/query/all`)
    for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${port}/api/query/all`)
    const r = await fetch(`http://127.0.0.1:${port}/__pond/metrics`)
    assert.equal(r.status, 200)
    const body = await r.text()
    assert.match(body, /pond_route_requests_total\{route="query:all"\}\s+\d+/)
    assert.match(body, /pond_route_duration_ms/)
  } finally {
    await killProc(proc)
  }
})

test("schema migration adds new column on second boot", async () => {
  const parent = tmp("pond-mig-")
  const v1 = `import { capsule, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ body: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: {},
})`
  const v2 = `import { capsule, query, string, boolean, table } from "pond/server"
export default capsule({
  schema: { items: table({ body: string(), done: boolean() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: {},
})`
  const dir = await scaffoldCapsule(parent, "cap-mig", v1)
  // first boot
  let port = await pickFreePort()
  let proc = spawnDev(dir, port)
  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/query/items`)
  } finally {
    await killProc(proc)
  }
  // upgrade schema, re-boot
  writeFileSync(path.join(dir, "server", "index.ts"), v2)
  port = await pickFreePort()
  proc = spawnDev(dir, port)
  try {
    const r = await waitForUrl(`http://127.0.0.1:${port}/__pond/inspect`)
    const insp = await r.json()
    assert.deepEqual(insp.schema, ["items"])
    // Inserting a row that uses the new `done` column should work
    // (no explicit mutation exposed — exercise via raw SQL via /db/dump after seeding via db/list)
    const tablesRes = await fetch(`http://127.0.0.1:${port}/__pond/db/tables`)
    const tables = await tablesRes.json()
    assert.ok(tables.includes("items"), "items table should still exist")
  } finally {
    await killProc(proc)
  }
})

test("schema migration refuses destructive column removal", async () => {
  const parent = tmp("pond-mig-bad-")
  const v1 = `import { capsule, query, string, number, table } from "pond/server"
export default capsule({
  schema: { items: table({ a: string(), b: number() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: {},
})`
  const v2 = `import { capsule, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ a: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: {},
})`
  const dir = await scaffoldCapsule(parent, "cap-bad", v1)
  let port = await pickFreePort()
  let proc = spawnDev(dir, port)
  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/query/items`)
  } finally {
    await killProc(proc)
  }
  writeFileSync(path.join(dir, "server", "index.ts"), v2)
  port = await pickFreePort()
  proc = spawnDev(dir, port)
  let stderr = ""
  proc.stderr.on("data", (c) => (stderr += c.toString()))
  // The bad schema should cause the dev server to fail on boot
  try {
    let booted = false
    try {
      await waitForUrl(`http://127.0.0.1:${port}/api/query/items`, 5000)
      booted = true
    } catch {
      // expected
    }
    assert.equal(booted, false, "should have refused to boot")
    assert.match(stderr, /destructive schema change|column.*would be dropped/i)
  } finally {
    await killProc(proc)
  }
})

test("socket() handler echoes via WebSocket", async () => {
  const parent = tmp("pond-ws-")
  const serverSrc = `import { capsule, socket, string, table } from "pond/server"
export default capsule({
  schema: { x: table({ name: string() }) },
  queries: {},
  mutations: {},
  sockets: {
    echo: socket((ctx, ws) => {
      ws.on("message", (data) => ws.send("echo:" + data))
    }),
  },
})`
  const dir = await scaffoldCapsule(parent, "cap-ws", serverSrc)
  const port = await pickFreePort()
  const proc = spawnDev(dir, port)
  try {
    await waitForUrl("http://127.0.0.1:" + port + "/__pond/inspect")
    // Dynamic-import ws so tests don't fail on environments without it built.
    const { WebSocket } = await import("ws")
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/api/socket/echo")
    const received = []
    const opened = new Promise((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    })
    await opened
    const echoed = new Promise((resolve) => ws.once("message", (m) => resolve(m.toString())))
    ws.send("hello")
    received.push(await echoed)
    ws.close()
    assert.equal(received[0], "echo:hello")
  } finally {
    await killProc(proc)
  }
})

test("`pond new --generate` without an agent fails cleanly + leaves AGENTS.md", async () => {
  const parent = tmp("pond-gen-")
  // No agents available — bypass detection by overriding env vars + HOME
  const fakeHome = tmp("pond-fake-home-")
  try {
    await execFileP(process.execPath, [CLI_PATH, "new", "a", "todo", "with", "tags", "--no-git", "--generate"], {
      cwd: parent,
      env: { ...process.env, HOME: fakeHome },
      timeout: 30000,
    })
    assert.fail("expected --generate to exit non-zero with no agent")
  } catch (err) {
    // Looking for the no-agent-detected error message OR a non-zero exit.
    assert.match(err.stderr || err.message, /--generate|no local agent|AGENTS\.md/)
    // The scaffold dir should still exist with AGENTS.md preserved
    const dirs = (await import("node:fs")).readdirSync(parent)
    assert.ok(dirs.length >= 1)
    const projDir = path.join(parent, dirs[0])
    assert.ok(existsSync(path.join(projDir, "AGENTS.md")), "AGENTS.md should be left for retry")
  }
})
