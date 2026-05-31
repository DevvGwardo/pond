// P1 item 7: collectSourceFiles must not follow symlinks out of the source tree.
// A symlink under server/ pointing at a secret outside cwd would otherwise be
// resolved and its contents uploaded with the deploy bundle.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { collectSourceFiles } from "../src/commands/deploy.js"

// Symlink creation needs elevated privileges on Windows; skip there.
const skip = process.platform === "win32"

test("collectSourceFiles skips symlinks (no traversal out of the source tree)", { skip }, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pond-collect-"))
  const outside = mkdtempSync(path.join(tmpdir(), "pond-secret-"))
  try {
    mkdirSync(path.join(cwd, "server"))
    writeFileSync(path.join(cwd, "server", "index.ts"), "export default {}\n")
    writeFileSync(path.join(cwd, "package.json"), '{"name":"x","type":"module"}\n')

    // A secret outside the project + a symlink pointing at it from inside server/.
    const secretFile = path.join(outside, "secret.txt")
    writeFileSync(secretFile, "TOPSECRET")
    symlinkSync(secretFile, path.join(cwd, "server", "leak.ts"))
    // ...and a symlinked directory escape.
    symlinkSync(outside, path.join(cwd, "server", "escape"))

    const out = collectSourceFiles(cwd)

    assert.ok(out["server/index.ts"], "real source file should be collected")
    assert.equal(out["server/leak.ts"], undefined, "symlinked file must be skipped")
    assert.equal(out["server/escape/secret.txt"], undefined, "symlinked dir must not be traversed")
    for (const [k, v] of Object.entries(out)) {
      assert.ok(!String(v).includes("TOPSECRET"), `symlinked secret leaked via ${k}`)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
