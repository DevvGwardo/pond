// Regression tests for the build import-confinement plugin. The hosted build
// runs esbuild over a tenant-controlled source tree; relative/absolute imports
// must never resolve outside the project root, even when:
//   - the import specifier lexically escapes (../../host-token),
//   - the import is an absolute path outside the root,
//   - an in-tree file is a symlink pointing outside the root (esbuild reads
//     through symlinks),
//   - the project root path itself traverses a symlink (e.g. /tmp or /var on
//     macOS) — the guard must not silently fail OPEN there.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { build as esbuild } from "esbuild"

import { confineImportsTo } from "../src/build-confinement.js"

// tmpdir() on macOS is /var/folders/... — a symlink to /private/var. Building
// the fixture under it exercises the realpath normalization both sides.
const OUTSIDE = mkdtempSync(path.join(tmpdir(), "confine-outside-"))
const ROOT = mkdtempSync(path.join(tmpdir(), "confine-root-"))

function fixture() {
  const clientDir = path.join(ROOT, "client")
  mkdirSync(clientDir, { recursive: true })
  writeFileSync(path.join(OUTSIDE, "escape-target.ts"), 'export const SECRET = "PWNED-OUTSIDE"\n')
  return clientDir
}

async function tryBuild(clientDir, entryContents) {
  writeFileSync(path.join(clientDir, "index.tsx"), entryContents)
  try {
    const r = await esbuild({
      stdin: {
        contents: 'import { App } from "./client/index.tsx"\nexport { App }\n',
        resolveDir: ROOT,
        sourcefile: "entry.tsx",
        loader: "tsx",
      },
      bundle: true,
      write: false,
      plugins: [confineImportsTo(ROOT)],
      logLevel: "silent",
    })
    return { blocked: false, text: r.outputFiles[0].text }
  } catch (e) {
    const msgs = JSON.stringify(e.errors || e.message || "")
    return { blocked: msgs.includes("escapes the project directory"), text: "" }
  }
}

test("lexical ../ import escape is rejected", async () => {
  const clientDir = fixture()
  // Import specifiers must use forward slashes even on Windows.
  const rel = path.relative(clientDir, path.join(OUTSIDE, "escape-target.ts")).split(path.sep).join("/")
  const r = await tryBuild(clientDir, `import { SECRET } from "${rel}"\nexport const App = () => SECRET\n`)
  assert.ok(r.blocked, "import escaping the root via ../ must be rejected")
})

test("absolute import escape is rejected", async () => {
  const clientDir = fixture()
  const abs = path.join(OUTSIDE, "escape-target.ts").split(path.sep).join("/")
  const r = await tryBuild(clientDir, `import { SECRET } from "${abs}"\nexport const App = () => SECRET\n`)
  assert.ok(r.blocked, "absolute import outside the root must be rejected")
})

test("in-root imports still bundle (no false positives)", async () => {
  const clientDir = fixture()
  writeFileSync(path.join(clientDir, "ok.ts"), 'export const OK = "FINE"\n')
  const r = await tryBuild(clientDir, 'import { OK } from "./ok.ts"\nexport const App = () => OK\n')
  assert.equal(r.blocked, false, "in-root import must not be rejected")
  assert.ok(r.text.includes("FINE"), "in-root module content must be bundled")
})

test("in-tree symlink pointing outside is rejected (esbuild reads through symlinks)", async () => {
  const clientDir = fixture()
  symlinkSync(path.join(OUTSIDE, "escape-target.ts"), path.join(clientDir, "leak.ts"))
  const r = await tryBuild(clientDir, 'import { SECRET } from "./leak.ts"\nexport const App = () => SECRET\n')
  assert.ok(r.blocked, "a symlinked import escaping the root must be rejected")
})

test("guard does not fail open when the project root path traverses a symlink", async () => {
  const clientDir = fixture()
  const rel = path.relative(clientDir, path.join(OUTSIDE, "escape-target.ts")).split(path.sep).join("/")
  writeFileSync(path.join(clientDir, "index.tsx"), `import { SECRET } from "${rel}"\nexport const App = () => SECRET\n`)
  try {
    await esbuild({
      stdin: {
        contents: 'import { App } from "./client/index.tsx"\nexport { App }\n',
        resolveDir: ROOT,
        sourcefile: "entry.tsx",
        loader: "tsx",
      },
      bundle: true,
      write: false,
      plugins: [confineImportsTo(ROOT)],
      logLevel: "silent",
    })
    assert.fail("escape must be rejected even when the root path contains symlinks (fail-open regression)")
  } catch (e) {
    assert.ok(JSON.stringify(e.errors || e.message || "").includes("escapes the project directory"))
  }
})

test("in-tree symlink to an in-root file is allowed (tenant's own content)", async () => {
  const clientDir = fixture()
  writeFileSync(path.join(ROOT, "shared.ts"), 'export const SECRET = "IN-ROOT"\n')
  symlinkSync(path.join(ROOT, "shared.ts"), path.join(clientDir, "link.ts"))
  const r = await tryBuild(clientDir, 'import { SECRET } from "./link.ts"\nexport const App = () => SECRET\n')
  assert.equal(r.blocked, false, "symlink staying inside the root is the tenant's own content")
  assert.ok(r.text.includes("IN-ROOT"))
})

test("missing imported file is not misreported as an escape", async () => {
  const clientDir = fixture()
  const r = await tryBuild(clientDir, 'import { Nope } from "./does-not-exist.ts"\nexport const App = () => Nope\n')
  assert.equal(r.blocked, false, "missing-file error belongs to esbuild, not the confinement plugin")
})

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})
