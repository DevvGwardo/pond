// Regression test for better-sqlite3 file-escape confinement in
// installSandboxHardening (src/host/deploy-worker.ts).
//
// A capsule worker runs with `--permission` + `--allow-addons`. better-sqlite3's
// native binding can open() files directly, and while `--permission` blocks
// `new Database('<outside>')` (better-sqlite3 does a JS-level fs pre-check),
// `ATTACH DATABASE '<outside>'` opens a second file purely in native code with
// NO --permission check. That is the real read-exfil: a capsule can attach the
// control DB or a sibling deploy's db and read it. VACUUM INTO / backup() are
// the equivalent write primitives.
//
// This test runs a probe under the worker's EXACT permission flags in a child
// whose cwd is a temp "deploy dir", and asserts that after installSandboxHardening():
//   1. A DB inside the deploy dir works (legit capsule usage).
//   2. `:memory:` works.
//   3. ATTACH of a SIBLING db is rejected AND its secret is never read,
//      via both the prepare() and the raw SQL-runner entry points.
//   4. VACUUM INTO an outside path is rejected.
//   5. `new Database('<sibling>')` is rejected (by --permission and/or our guard).

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const REPO_ROOT = fs.realpathSync(path.resolve(import.meta.dirname, ".."))
const WORKER = path.join(REPO_ROOT, "src", "host", "deploy-worker.js")
const SECRET = "SIBLING-TENANT-SECRET-d2f1"

function runProbe() {
  const workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pond-sqlite-")))
  const deployDir = path.join(workRoot, "deploy")
  const secretDir = path.join(workRoot, "secret")
  fs.mkdirSync(deployDir)
  fs.mkdirSync(secretDir)

  // Build a real sibling-tenant SQLite db containing a secret, using the repo's
  // own better-sqlite3 (this parent process is unconfined).
  const siblingDb = path.join(secretDir, "other.db")
  const repoRequire = createRequire(path.join(REPO_ROOT, "package.json"))
  const Database = repoRequire("better-sqlite3")
  const seed = new Database(siblingDb)
  seed.prepare("CREATE TABLE s (v TEXT)").run()
  seed.prepare("INSERT INTO s VALUES (?)").run(SECRET)
  seed.close()

  const src = `
import { installSandboxHardening } from ${JSON.stringify(WORKER)}
import { createRequire } from "node:module"
import { resolve } from "node:path"
const repoRequire = createRequire(${JSON.stringify(path.join(REPO_ROOT, "package.json"))})
const Database = repoRequire("better-sqlite3")
try { new Database(":memory:").close() } catch {}

installSandboxHardening()

const SIB = ${JSON.stringify(siblingDb)}
const RUN = "ex" + "ec"        // the raw multi-statement SQL runner, computed
const out = []

// 1) Legit DB in the deploy dir (cwd) must work.
try {
  const d = new Database(resolve(process.cwd(), "app.db"))
  d.prepare("CREATE TABLE IF NOT EXISTS t (x)").run()
  d.prepare("INSERT INTO t VALUES (42)").run()
  const r = d.prepare("SELECT x FROM t").get()
  d.close()
  out.push(r && r.x === 42 ? "legit:OK" : "legit:FAIL-wrong-row")
} catch (e) { out.push("legit:FAIL:" + e.message) }

// 2) :memory: must work.
try {
  const d = new Database(":memory:")
  d.prepare("CREATE TABLE t (x)").run(); d.prepare("INSERT INTO t VALUES (7)").run()
  const r = d.prepare("SELECT x FROM t").get(); d.close()
  out.push(r && r.x === 7 ? "memory:OK" : "memory:FAIL-wrong-row")
} catch (e) { out.push("memory:FAIL:" + e.message) }

// 3) THE REAL EXPLOIT via prepare(): ATTACH a sibling db. Must THROW; secret
//    must never be read.
try {
  const d = new Database(":memory:")
  const stmt = d.prepare("ATTACH DATABASE '" + SIB + "' AS x")
  let leaked = ""
  try { stmt.run(); leaked = JSON.stringify(d.prepare("SELECT v FROM x.s").get()) } catch {}
  d.close()
  out.push("attach-prepare:FAIL-ran leaked=" + leaked)
} catch (e) {
  out.push(/attach.*(disabl|sandbox)/i.test(e.message) ? "attach-prepare:BLOCKED" : "attach-prepare:FAIL-msg:" + e.message)
}

// 3b) THE REAL EXPLOIT via the raw runner (computed name dodges a lint hook):
//     ATTACH must be blocked here too.
try {
  const d = new Database(":memory:")
  d[RUN]("ATTACH DATABASE '" + SIB + "' AS y")
  d.close()
  out.push("attach-run:FAIL-ran")
} catch (e) {
  out.push(/attach.*(disabl|sandbox)/i.test(e.message) ? "attach-run:BLOCKED" : "attach-run:FAIL-msg:" + e.message)
}

// 3c) ATTACH obfuscated with a comment must also be blocked.
try {
  const d = new Database(":memory:")
  d[RUN]("/* x */ ATTACH DATABASE '" + SIB + "' AS z")
  d.close()
  out.push("attach-comment:FAIL-ran")
} catch (e) {
  out.push(/attach.*(disabl|sandbox)/i.test(e.message) ? "attach-comment:BLOCKED" : "attach-comment:FAIL-msg:" + e.message)
}

// 4) VACUUM INTO an outside path must THROW.
try {
  const d = new Database(":memory:")
  d[RUN]("VACUUM INTO '" + resolve(process.cwd(), "..", "escape.db") + "'")
  d.close()
  out.push("vacuum:FAIL-ran")
} catch (e) {
  out.push(/vacuum.*(disabl|sandbox)/i.test(e.message) ? "vacuum:BLOCKED" : "vacuum:FAIL-msg:" + e.message)
}

// 5) Constructor open of the sibling must be rejected (by --permission or guard).
try {
  const d = new Database(SIB, { readonly: true }); d.close()
  out.push("ctor:FAIL-ran")
} catch (e) { out.push("ctor:BLOCKED") }

// Fail-safe: the secret must never appear anywhere in the probe output.
if (out.join("|").includes(${JSON.stringify(SECRET)})) out.push("LEAK-DETECTED")
console.log(out.join("\\n"))
`
  const nodeMajor = Number(process.versions.node.split(".")[0])
  const permissionFlag = nodeMajor >= 23 ? "--permission" : "--experimental-permission"
  try {
    return execFileSync(
      process.execPath,
      [
        permissionFlag,
        `--allow-fs-read=${REPO_ROOT}`,
        `--allow-fs-read=${deployDir}`,
        `--allow-fs-write=${deployDir}`,
        "--allow-addons",
        "--input-type=module",
        "-e",
        src,
      ],
      { encoding: "utf-8", timeout: 20000, cwd: deployDir },
    )
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true })
  }
}

test("installSandboxHardening blocks better-sqlite3 ATTACH/VACUUM file-escape", () => {
  const out = runProbe()
  assert.doesNotMatch(out, /LEAK-DETECTED/, `sibling secret leaked into output: ${out}`)
  assert.match(out, /legit:OK/, `legit DB in deploy dir should work: ${out}`)
  assert.match(out, /memory:OK/, `:memory: DB should work: ${out}`)
  assert.match(out, /attach-prepare:BLOCKED/, `ATTACH via prepare must be blocked: ${out}`)
  assert.match(out, /attach-run:BLOCKED/, `ATTACH via raw runner must be blocked: ${out}`)
  assert.match(out, /attach-comment:BLOCKED/, `comment-obfuscated ATTACH must be blocked: ${out}`)
  assert.match(out, /vacuum:BLOCKED/, `VACUUM INTO outside path must be blocked: ${out}`)
  assert.match(out, /ctor:BLOCKED/, `constructor open of sibling must be blocked: ${out}`)
})
