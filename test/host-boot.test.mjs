// Regression test for the 2026-05-27 TDZ on `publicListingCache`.
//
// Before the fix, booting `pond host` against a data-dir that already
// contained at least one hosted deploy crashed immediately with
//   ReferenceError: Cannot access 'publicListingCache' before initialization
// because `let publicListingCache` was declared ~1400 lines below
// `writeRecord()` inside the same run() closure. The standard test suite
// boots `pond host` against an empty data-dir, so the regression was silent.
//
// This test seeds a deploy on disk, spawns the host, and asserts it stays
// alive long enough to serve `/api/health`. A TDZ regression makes the
// host exit within ~100ms; the timeout below is generous on cold machines.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import { randomBytes } from "node:crypto"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")

const cleanupDirs = []
const cleanupProcs = []

after(async () => {
  for (const p of cleanupProcs) {
    if (p && p.exitCode === null) {
      const exited = new Promise((r) => p.once("exit", r))
      p.kill("SIGINT")
      const t = setTimeout(() => p.kill("SIGKILL"), 3000)
      t.unref()
      await exited
      clearTimeout(t)
    }
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

test("pond host boots with an existing deploy on disk (TDZ-on-publicListingCache regression)", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "pond-host-boot-"))
  cleanupDirs.push(dataDir)

  // Seed a hosted deploy. Shape mirrors what host.ts writeRecord persists.
  // The bundle file is intentionally empty — forkDeploy proceeds past the
  // existsSync(bundlePath) gate, hits writeRecord, and that's the path that
  // triggered the pre-fix TDZ error.
  const deployId = "a".repeat(16)
  const deployDir = path.join(dataDir, "deploys", deployId)
  mkdirSync(deployDir, { recursive: true })
  writeFileSync(
    path.join(deployDir, "deploy.json"),
    JSON.stringify(
      {
        deployId,
        url: `http://${deployId}.localhost`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        bundleHash: "0".repeat(64),
        publicInspect: false,
      },
      null,
      2,
    ),
  )
  // Minimal-but-existent bundle so forkDeploy doesn't early-return.
  writeFileSync(path.join(deployDir, "deploy-bundle.mjs"), "export default {}\n")

  const port = await pickFreePort()
  const apiUrl = `http://127.0.0.1:${port}`

  let stderrBuf = ""
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
      "localhost",
      "--data-dir",
      dataDir,
      "--anonymous-rate-per-hour",
      "100",
    ],
    {
      env: { ...process.env, POND_HOST_TOKEN: randomBytes(16).toString("hex") },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  )
  cleanupProcs.push(proc)
  proc.stdout.on("data", () => {})
  proc.stderr.on("data", (c) => {
    stderrBuf += c.toString("utf8")
  })

  // Race the host's health endpoint against the host's own death.
  const earlyExit = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })))
  const healthy = (async () => {
    const start = Date.now()
    while (Date.now() - start < 8000) {
      try {
        const r = await fetch(`${apiUrl}/api/health`)
        if (r.ok) return "healthy"
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return "timeout"
  })()

  const result = await Promise.race([healthy, earlyExit])
  if (typeof result === "object" && result !== null && "code" in result) {
    assert.fail(
      `pond host exited before /api/health became reachable (code=${result.code} signal=${result.signal}). ` +
        `This is the regression class — pre-fix this happens with code=1 and stderr containing 'Cannot access publicListingCache before initialization'. ` +
        `stderr=\n${stderrBuf}`,
    )
  }
  assert.equal(result, "healthy", `host never became healthy: stderr=\n${stderrBuf}`)
  assert.match(
    stderrBuf + "\n",
    /(^[\s\S]*$)/, // catch-all so we still record stderr in test output via the assertion message above
  )
})
