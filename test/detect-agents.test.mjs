import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { detectHermes, detectClaude, detectCodex, detectAgents } from "../src/detect-agents.js"

const execFileP = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

test("detectHermes finds the `hermes` CLI on PATH", async () => {
  const result = await detectHermes({
    which: (cmd) => (cmd === "hermes" ? "/usr/local/bin/hermes" : null),
  })
  assert.equal(result?.name, "hermes")
  assert.equal(result?.detail, "/usr/local/bin/hermes")
})

test("detectHermes returns null when `hermes` isn't on PATH", async () => {
  const result = await detectHermes({ which: () => null, existsSync: () => false })
  assert.equal(result, null)
})

test("detectHermes ignores `hermes-agent` (chat REPL, not a usable CLI)", async () => {
  const result = await detectHermes({
    which: (cmd) => (cmd === "hermes-agent" ? "/opt/homebrew/bin/hermes-agent" : null),
    existsSync: () => false,
  })
  assert.equal(result, null)
})

test("detectHermes finds Windows `pip install --user` install when not on PATH", async () => {
  const home = "C:\\Users\\Admin"
  const env = {
    APPDATA: "C:\\Users\\Admin\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local",
  }
  const target = path.win32.join(env.APPDATA, "Python", "Python311", "Scripts", "hermes.exe")
  const result = await detectHermes({
    platform: "win32",
    homedir: () => home,
    env,
    which: () => null,
    existsSync: (p) => p === target,
  })
  assert.equal(result?.name, "hermes")
  assert.equal(result?.detail, target)
})

test("detectHermes finds Windows pipx install when not on PATH", async () => {
  const home = "C:\\Users\\Admin"
  const env = {
    APPDATA: "C:\\Users\\Admin\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local",
  }
  const target = path.win32.join(env.LOCALAPPDATA, "pipx", "venvs", "hermes-agent", "Scripts", "hermes.exe")
  const result = await detectHermes({
    platform: "win32",
    homedir: () => home,
    env,
    which: () => null,
    existsSync: (p) => p === target,
  })
  assert.equal(result?.detail, target)
})

test("detectHermes finds Windows conda install when not on PATH", async () => {
  const home = "C:\\Users\\Admin"
  const env = { APPDATA: "C:\\X", LOCALAPPDATA: "C:\\Y" }
  const target = path.win32.join(home, "miniconda3", "Scripts", "hermes.exe")
  const result = await detectHermes({
    platform: "win32",
    homedir: () => home,
    env,
    which: () => null,
    existsSync: (p) => p === target,
  })
  assert.equal(result?.detail, target)
})

test("detectHermes returns null on Windows when neither PATH nor known dirs match", async () => {
  const result = await detectHermes({
    platform: "win32",
    homedir: () => "C:\\Users\\Admin",
    env: { APPDATA: "C:\\X", LOCALAPPDATA: "C:\\Y" },
    which: () => null,
    existsSync: () => false,
  })
  assert.equal(result, null)
})

test("detectHermes finds Unix pipx fallback when not on PATH", async () => {
  const home = "/home/dev"
  const target = path.posix.join(home, ".local", "pipx", "venvs", "hermes-agent", "bin", "hermes")
  const result = await detectHermes({
    platform: "linux",
    homedir: () => home,
    which: () => null,
    existsSync: (p) => p === target,
  })
  assert.equal(result?.detail, target)
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

test("detectAgents returns hermes first when multiple present", async () => {
  const home = tmp("home-multi-")
  try {
    mkdirSync(path.join(home, ".claude"), { recursive: true })
    mkdirSync(path.join(home, ".codex"), { recursive: true })
    writeFileSync(path.join(home, ".codex", "auth.json"), "{}")
    const result = await detectAgents({
      homedir: () => home,
      which: (cmd) => (cmd === "hermes" ? "/usr/local/bin/hermes" : null),
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

test("copyTemplate({ useStub: true }) writes blank-canvas stubs, not a template", async () => {
  const { copyTemplate } = await import("../src/template.js")
  const { STUB_SERVER_TS } = await import("../src/templates.js")
  const parent = tmp("pond-stub-")
  const prev = process.cwd()
  try {
    process.chdir(parent)
    const result = await copyTemplate({
      name: "stub-cap",
      templateName: "todo", // would normally win the heuristic
      initGit: false,
      prompt: "a habit tracker",
      useStub: true,
    })
    assert.equal(result.template, null, "template should be null in stub mode")
    const server = readFileSync(path.join(parent, "stub-cap", "server", "index.ts"), "utf-8")
    assert.equal(server, STUB_SERVER_TS, "server file should be the stub verbatim")
    const agents = readFileSync(path.join(parent, "stub-cap", "AGENTS.md"), "utf-8")
    assert.match(agents, /empty stubs/, "AGENTS.md should tell the agent it's working from stubs")
  } finally {
    process.chdir(prev)
    rmSync(parent, { recursive: true, force: true })
  }
})

test("pickTemplateForPrompt picks todo for tracker-style prompts (broadened keywords)", async () => {
  const { pickTemplateForPrompt } = await import("../src/templates.js")
  for (const p of ["a habit tracker", "an expense tracker for roommates", "weekly journal"]) {
    const t = pickTemplateForPrompt(p)
    assert.equal(t.name, "todo", `expected todo for "${p}", got ${t.name}`)
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
