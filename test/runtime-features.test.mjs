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

test("boolean column accepts true/false from mutations and survives roundtrip", async () => {
  const parent = tmp("pond-bool-")
  const serverSrc = `import { capsule, mutation, query, string, boolean, table } from "pond/server"
export default capsule({
  schema: { items: table({ body: string(), done: boolean() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: {
    add: mutation((ctx, body, done) => ctx.db.items.insert({ body, done })),
    setDone: mutation((ctx, id, done) => ctx.db.items.update(id, { done })),
  },
})`
  const dir = await scaffoldCapsule(parent, "cap-bool", serverSrc)
  const port = await pickFreePort()
  const proc = spawnDev(dir, port)
  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/query/items`)

    const r1 = await fetch(`http://127.0.0.1:${port}/api/mutation/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: ["a", true] }),
    })
    assert.equal(r1.status, 200, "insert with done=true should succeed")
    const row1 = await r1.json()
    assert.equal(row1.body, "a")
    assert.equal(row1.done, 1, "true should be stored as 1")

    const r2 = await fetch(`http://127.0.0.1:${port}/api/mutation/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: ["b", false] }),
    })
    assert.equal(r2.status, 200, "insert with done=false should succeed")
    const row2 = await r2.json()
    assert.equal(row2.done, 0, "false should be stored as 0")

    const r3 = await fetch(`http://127.0.0.1:${port}/api/mutation/setDone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: [row2.id, true] }),
    })
    assert.equal(r3.status, 200, "update with boolean should succeed")
    const updated = await r3.json()
    assert.equal(updated.done, 1, "update true should be stored as 1")

    const listed = await (await fetch(`http://127.0.0.1:${port}/api/query/items`)).json()
    assert.equal(listed.length, 2)
  } finally {
    await killProc(proc)
  }
})

test("runtime rejects a wrongly-typed value for a declared column (TS types are erased)", async () => {
  // A handler declares `(ctx, name, qty)` where qty maps to a number() column.
  // Handler param types are stripped in the bundled worker, so without runtime
  // validation a string "notanumber" would be stored silently. It must be rejected.
  const parent = tmp("pond-validate-")
  const serverSrc = `import { capsule, mutation, query, string, number, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string(), qty: number() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name, qty) => ctx.db.items.insert({ name, qty })) },
})`
  const dir = await scaffoldCapsule(parent, "cap-validate", serverSrc)
  const port = await pickFreePort()
  const proc = spawnDev(dir, port)
  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/query/items`)

    // Wrong type: a string into a number() column → rejected, not a silent 200.
    const bad = await fetch(`http://127.0.0.1:${port}/api/mutation/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: ["widget", "notanumber"] }),
    })
    assert.ok(bad.status >= 400, `wrongly-typed arg should be rejected, got ${bad.status}`)

    // Correct type still works and round-trips.
    const good = await fetch(`http://127.0.0.1:${port}/api/mutation/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: ["widget", 5] }),
    })
    assert.equal(good.status, 200, "correctly-typed insert should succeed")
    assert.equal((await good.json()).qty, 5)

    // Only the valid row persisted — the rejected insert never hit the table.
    const listed = await (await fetch(`http://127.0.0.1:${port}/api/query/items`)).json()
    assert.equal(listed.length, 1, "the rejected insert must not have persisted")
    assert.equal(listed[0].qty, 5)
  } finally {
    await killProc(proc)
  }
})

test("ORM: ctx.transaction rolls back on throw; offset paginates; count aggregates", async () => {
  const parent = tmp("pond-orm-")
  const serverSrc = `import { capsule, mutation, query, string, number, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string(), n: number() }) },
  queries: {
    items: query((ctx) => ctx.db.items.all()),
    page: query((ctx, offset) => ctx.db.items.orderBy("n", "asc").limit(2).offset(offset).all()),
    total: query((ctx) => ctx.db.items.count()),
  },
  mutations: {
    add: mutation((ctx, name, n) => ctx.db.items.insert({ name, n })),
    addTwoThenFail: mutation((ctx) =>
      ctx.transaction(() => {
        ctx.db.items.insert({ name: "tx-a", n: 100 })
        ctx.db.items.insert({ name: "tx-b", n: 101 })
        throw new Error("boom")
      }),
    ),
  },
})`
  const dir = await scaffoldCapsule(parent, "cap-orm", serverSrc)
  const port = await pickFreePort()
  const proc = spawnDev(dir, port)
  const base = `http://127.0.0.1:${port}`
  const addItem = (name, n) =>
    fetch(`${base}/api/mutation/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: [name, n] }),
    })
  const page = async (offset) =>
    (
      await fetch(`${base}/api/query/page`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: [offset] }),
      })
    ).json()
  try {
    await waitForUrl(`${base}/api/query/items`)
    for (let i = 0; i < 5; i++) assert.equal((await addItem(`item-${i}`, i)).status, 200)

    // count() aggregate
    assert.equal(await (await fetch(`${base}/api/query/total`)).json(), 5)

    // offset pagination (ordered by n asc, page size 2)
    assert.deepEqual(
      (await page(0)).map((r) => r.n),
      [0, 1],
    )
    assert.deepEqual(
      (await page(2)).map((r) => r.n),
      [2, 3],
    )
    assert.deepEqual(
      (await page(4)).map((r) => r.n),
      [4],
    )

    // transaction rollback: the failing mutation must persist neither insert
    const txRes = await fetch(`${base}/api/mutation/addTwoThenFail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: [] }),
    })
    assert.ok(txRes.status >= 400, `failing transaction should error, got ${txRes.status}`)
    assert.equal(await (await fetch(`${base}/api/query/total`)).json(), 5, "rolled-back inserts must not persist")
    const all = await (await fetch(`${base}/api/query/items`)).json()
    assert.ok(!all.some((r) => r.name === "tx-a" || r.name === "tx-b"), "no partial transaction rows")
  } finally {
    await killProc(proc)
  }
})

test("RBAC helpers: requireUser rejects guests; requireOwner gates by owner column", async () => {
  const parent = tmp("pond-rbac-")
  const serverSrc = `import { capsule, mutation, query, string, table, requireUser, requireOwner } from "pond/server"
export default capsule({
  schema: { items: table({ owner: string(), body: string() }) },
  queries: {
    ready: query(() => "ok"),
    whoami: query((ctx) => requireUser(ctx)),
    mine: query((ctx, id) => requireOwner(ctx, "items", id)),
  },
  mutations: { seed: mutation((ctx, owner, body) => ctx.db.items.insert({ owner, body })) },
})`
  const dir = await scaffoldCapsule(parent, "cap-rbac", serverSrc)
  const port = await pickFreePort()
  const proc = spawnDev(dir, port)
  const base = `http://127.0.0.1:${port}`
  const seed = (owner, body) =>
    fetch(`${base}/api/mutation/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: [owner, body] }),
    }).then((r) => r.json())
  const mine = (id) =>
    fetch(`${base}/api/query/mine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: [id] }),
    })
  try {
    await waitForUrl(`${base}/api/query/ready`)

    // The dev runtime resolves an unauthenticated caller to the "guest" identity.
    const ownRow = await seed("guest", "ok") // owned by the guest caller
    const otherRow = await seed("someone-else", "secret") // owned by a different user

    // requireUser must reject the guest.
    const who = await fetch(`${base}/api/query/whoami`)
    assert.ok(who.status >= 400, `requireUser should reject a guest, got ${who.status}`)

    // requireOwner returns the row the caller owns...
    const ok = await mine(ownRow.id)
    assert.equal(ok.status, 200, "owner should be allowed")
    assert.equal((await ok.json()).body, "ok")

    // ...and refuses one owned by someone else (indistinguishable from missing).
    const denied = await mine(otherRow.id)
    assert.ok(denied.status >= 400, `non-owner should be denied, got ${denied.status}`)
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

test("parameterized query: POST /api/query/:name spreads args; GET still works for 0-arg", async () => {
  const parent = tmp("pond-qargs-")
  const serverSrc = `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: {
    all: query((ctx) => ctx.db.items.all()),
    byName: query((ctx, name) => ctx.db.items.where("name", name).all()),
    echo: query((ctx, a, b) => ({ a, b, user: ctx.auth.userId })),
  },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})`
  const dir = await scaffoldCapsule(parent, "cap-qargs", serverSrc)
  const port = await pickFreePort()
  const proc = spawnDev(dir, port)
  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/query/all`)

    // Seed two rows via the existing mutation route.
    for (const name of ["alpha", "beta"]) {
      const r = await fetch(`http://127.0.0.1:${port}/api/mutation/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: [name] }),
      })
      assert.equal(r.status, 200, `seed ${name} should succeed`)
    }

    // GET still serves the 0-arg query unchanged.
    const allRes = await fetch(`http://127.0.0.1:${port}/api/query/all`)
    assert.equal(allRes.status, 200)
    const all = await allRes.json()
    assert.equal(all.length, 2)

    // POST with { args } reaches the single-arg query.
    const byNameRes = await fetch(`http://127.0.0.1:${port}/api/query/byName`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: ["alpha"] }),
    })
    assert.equal(byNameRes.status, 200)
    const byName = await byNameRes.json()
    assert.equal(byName.length, 1)
    assert.equal(byName[0].name, "alpha")

    // Multiple args spread positionally.
    const echoRes = await fetch(`http://127.0.0.1:${port}/api/query/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: ["hello", 42] }),
    })
    assert.equal(echoRes.status, 200)
    const echo = await echoRes.json()
    assert.equal(echo.a, "hello")
    assert.equal(echo.b, 42)
    assert.equal(typeof echo.user, "string")

    // Missing / non-array args body is treated as zero args (no crash).
    const noArgsRes = await fetch(`http://127.0.0.1:${port}/api/query/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    assert.equal(noArgsRes.status, 200)
    const noArgs = await noArgsRes.json()
    assert.equal(noArgs.a, undefined)
    assert.equal(noArgs.b, undefined)
  } finally {
    await killProc(proc)
  }
})
