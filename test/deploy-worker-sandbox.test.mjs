// Regression test for the native-code lockdown installed in every capsule
// worker (installSandboxHardening in src/host/deploy-worker.ts).
//
// The Node `--permission` model is the only thing isolating one tenant's files
// from another's on the shared-uid host, but the worker runs with --allow-addons
// (the runtime's better-sqlite3 is a native addon). Any path to running native
// code — process.dlopen, require('*.node'), or SQLite's loadExtension — lets a
// capsule bypass --permission with libc syscalls and read the control DB /
// sibling tenants' secrets. This test runs a probe under the worker's EXACT
// permission flags, calls the hardening, and asserts every native-load surface
// is sealed while the runtime's own (already-loaded) better-sqlite3 keeps working.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const WORKER = path.join(REPO_ROOT, "src", "host", "deploy-worker.js")
// ESM import in the embedded probe must be a file:// URL, not a bare absolute
// path — on Windows a `C:\…` / `D:\…` specifier is rejected (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const WORKER_URL = pathToFileURL(WORKER).href

function runHardenedProbe() {
  // realpath so cwd / process.cwd() / the db path all agree (macOS /var ->
  // /private/var), exactly as forkDeploy realpaths realDir before forking.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pond-sandbox-")))
  const dbPath = path.join(tmp, "data.db")
  const src = `
import { installSandboxHardening } from ${JSON.stringify(WORKER_URL)}
import { createRequire } from "node:module"
// Anchor module resolution at the repo (not cwd/import.meta.url): the worker
// runs from the deploy dir, which has no node_modules of its own.
const require = createRequire(${JSON.stringify(path.join(REPO_ROOT, "package.json"))})
const Database = require("better-sqlite3")
// pond's runtime opens the capsule db before hardening runs:
const pre = new Database(${JSON.stringify(dbPath)})
pre.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)")
pre.close()

installSandboxHardening()

const out = []
// 1) process.dlopen sealed (backs require('*.node') + { nativeBinding })
try { process.dlopen({ exports: {} }, "/no/such.node"); out.push("dlopen:FAIL-ran") }
catch (e) { out.push(/native addons is disabled/.test(e.message) ? "dlopen:OK" : "dlopen:FAIL:" + e.message) }
// 2) process.dlopen is non-writable — capsule can't restore the native one
try { process.dlopen = () => {}; out.push("reassign:FAIL-assigned") }
catch { out.push("reassign:OK") }
// 3) better-sqlite3 loadExtension sealed (C-level dlopen, separate surface)
try { const d = new Database(${JSON.stringify(dbPath)}); d.loadExtension("/no/such.so"); out.push("ext:FAIL-ran") }
catch (e) { out.push(/extension loading is disabled/.test(e.message) ? "ext:OK" : "ext:FAIL:" + e.message) }
// 4) the runtime's own in-bounds better-sqlite3 must still work
try { const d = new Database(${JSON.stringify(dbPath)}); const r = d.prepare("SELECT 7 AS x").get(); out.push(r && r.x === 7 ? "db:OK" : "db:FAIL-row") }
catch (e) { out.push("db:FAIL:" + e.message) }
console.log(out.join("\\n"))
`
  // Mirror the runtime's flag selection (src/commands/host.js): Node 24 removed
  // `--experimental-permission` and Node 22 LTS shipped before the stable
  // `--permission` rename (Node 23+), so older lines need the experimental form.
  const nodeMajor = Number(process.versions.node.split(".")[0])
  const permissionFlag = nodeMajor >= 23 ? "--permission" : "--experimental-permission"
  try {
    return execFileSync(
      process.execPath,
      [
        permissionFlag,
        `--allow-fs-read=${REPO_ROOT}`,
        `--allow-fs-read=${tmp}`,
        `--allow-fs-write=${tmp}`,
        "--allow-addons",
        "--input-type=module",
        "-e",
        src,
      ],
      // Run from the deploy dir, exactly as the real worker does (forkDeploy
      // sets cwd: realDir). The capsule's own data.db lives in cwd, which is what
      // the native-construction path guard confines opens to.
      { encoding: "utf-8", timeout: 20000, cwd: tmp },
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

test("capsule sandbox hardening seals every native-code escape while keeping better-sqlite3 usable", () => {
  const out = runHardenedProbe()
  assert.match(out, /dlopen:OK/, `process.dlopen not sealed: ${out}`)
  assert.match(out, /reassign:OK/, `process.dlopen is reassignable: ${out}`)
  assert.match(out, /ext:OK/, `better-sqlite3 loadExtension not sealed: ${out}`)
  assert.match(out, /db:OK/, `runtime better-sqlite3 broke under hardening: ${out}`)
})
