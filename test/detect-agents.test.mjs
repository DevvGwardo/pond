import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  detectHermes,
  detectClaude,
  detectCodex,
  detectAgents,
  detectHermesInstall,
} from "../src/detect-agents.js"

const execFileP = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

test("detectHermes returns null when nothing responds", async () => {
  const result = await detectHermes({
    fetch: async () => {
      throw new Error("ECONNREFUSED")
    },
  })
  assert.equal(result, null)
})

test("detectHermes returns positive on 200 / 404 / 405", async () => {
  for (const status of [200, 404, 405]) {
    const result = await detectHermes({
      fetch: async () => new Response("", { status }),
    })
    assert.equal(result?.name, "hermes", `status ${status}`)
  }
})

test("detectHermes returns null on 401 (auth-gated → unusable)", async () => {
  const result = await detectHermes({
    fetch: async () => new Response("", { status: 401 }),
  })
  assert.equal(result, null)
})

test("detectClaude finds ~/.claude when present", async () => {
  const home = tmp("home-claude-")
  try {
    mkdirSync(path.join(home, ".claude"), { recursive: true })
    const result = await detectClaude({
      homedir: () => home,
      which: () => null,
    })
    assert.equal(result?.name, "claude")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("detectClaude returns null when ~/.claude missing", async () => {
  const home = tmp("home-no-claude-")
  try {
    const result = await detectClaude({ homedir: () => home, which: () => null })
    assert.equal(result, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("detectCodex finds ~/.codex/auth.json when present", async () => {
  const home = tmp("home-codex-")
  try {
    mkdirSync(path.join(home, ".codex"), { recursive: true })
    writeFileSync(path.join(home, ".codex", "auth.json"), "{}")
    const result = await detectCodex({ homedir: () => home, which: () => null })
    assert.equal(result?.name, "codex")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("detectHermesInstall surfaces a binary on PATH", () => {
  const found = detectHermesInstall({
    which: (cmd) => (cmd === "hermes-agent" ? "/opt/homebrew/bin/hermes-agent" : null),
    homedir: () => "/tmp/nope",
    existsSync: () => false,
  })
  assert.equal(found, "/opt/homebrew/bin/hermes-agent")
})

test("detectHermesInstall finds ~/.hermes-agent when no binary", () => {
  const home = tmp("home-hermes-")
  try {
    mkdirSync(path.join(home, ".hermes-agent"), { recursive: true })
    const found = detectHermesInstall({
      which: () => null,
      homedir: () => home,
    })
    assert.equal(found, path.join(home, ".hermes-agent"))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("detectHermesInstall returns null when nothing's installed", () => {
  const home = tmp("home-empty-")
  try {
    const found = detectHermesInstall({
      which: () => null,
      homedir: () => home,
    })
    assert.equal(found, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("detectAgents returns hermes first when multiple present", async () => {
  const home = tmp("home-multi-")
  try {
    mkdirSync(path.join(home, ".claude"), { recursive: true })
    mkdirSync(path.join(home, ".codex"), { recursive: true })
    writeFileSync(path.join(home, ".codex", "auth.json"), "{}")
    const result = await detectAgents({
      fetch: async () => new Response("", { status: 200 }),
      homedir: () => home,
      which: () => null,
    })
    assert.deepEqual(
      result.map((r) => r.name),
      ["hermes", "claude", "codex"],
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("`pond new --list-templates` lists 5+ templates", async () => {
  const { stdout } = await execFileP(process.execPath, [CLI_PATH, "new", "--list-templates"], {
    env: { ...process.env },
    timeout: 10000,
  })
  for (const name of ["todo", "auth-app", "blog", "chat", "dashboard", "webhook-handler"]) {
    assert.match(stdout, new RegExp(`\\b${name}\\b`), `missing template: ${name}`)
  }
})

test("`pond new --template chat` scaffolds chat template", async () => {
  const parent = tmp("pond-cli-chat-")
  try {
    await execFileP(process.execPath, [CLI_PATH, "new", "my-chat", "--no-git", "--template", "chat"], {
      cwd: parent,
      env: { ...process.env },
      timeout: 30000,
    })
    const server = readFileSync(path.join(parent, "my-chat", "server", "index.ts"), "utf-8")
    assert.match(server, /authorName/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("`pond new <prompt>` heuristically picks chat for chat-y prompts", async () => {
  const parent = tmp("pond-cli-heuristic-")
  try {
    await execFileP(
      process.execPath,
      [CLI_PATH, "new", "a", "realtime", "chat", "room", "for", "friends", "--no-git"],
      { cwd: parent, env: { ...process.env }, timeout: 30000 },
    )
    const dirs = readdirSync(parent)
    assert.ok(dirs.length === 1, `expected one scaffold dir, got: ${dirs.join(", ")}`)
    const server = readFileSync(path.join(parent, dirs[0], "server", "index.ts"), "utf-8")
    assert.match(server, /authorName/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("`pond new` writes .cursor/rules and .claude/CLAUDE.md", async () => {
  const parent = tmp("pond-cli-rules-")
  try {
    await execFileP(process.execPath, [CLI_PATH, "new", "rules-cap", "--no-git"], {
      cwd: parent,
      env: { ...process.env },
      timeout: 30000,
    })
    const projDir = path.join(parent, "rules-cap")
    assert.ok(existsSync(path.join(projDir, ".cursor", "rules", "pond.mdc")))
    assert.ok(existsSync(path.join(projDir, ".claude", "CLAUDE.md")))
    const rules = readFileSync(path.join(projDir, ".cursor", "rules", "pond.mdc"), "utf-8")
    assert.match(rules, /alwaysApply/)
    assert.match(rules, /Pond capsule contract/i)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
