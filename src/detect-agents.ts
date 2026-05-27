import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { spawn } from "node:child_process"

export type AgentName = "hermes" | "claude" | "codex"

export interface DetectedAgent {
  name: AgentName
  detail: string
}

interface DetectionDeps {
  homedir?: () => string
  existsSync?: typeof fs.existsSync
  which?: (cmd: string) => string | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

function defaultWhich(cmd: string): string | null {
  const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of paths) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext)
      try {
        const st = fs.statSync(p)
        if (st.isFile()) return p
      } catch {
        // not found
      }
    }
  }
  return null
}

export async function detectHermes(deps: DetectionDeps = {}): Promise<DetectedAgent | null> {
  // Hermes ships a real CLI (`hermes`) with a non-interactive one-shot flag
  // (`hermes -z "<prompt>"`). That's what we drive — same shape as claude /
  // codex below. `hermes-agent` is intentionally NOT considered: it's a
  // chat REPL shim that ignores subcommands and runs a hard-coded demo query.
  const which = deps.which ?? defaultWhich
  const onPath = which("hermes")
  if (onPath) return { name: "hermes", detail: onPath }

  // PATH miss is common on Windows: `pip install hermes-agent` drops
  // `hermes.exe` into a Python `Scripts/` dir that often isn't on the
  // PowerShell PATH. Probe known install locations as a fallback so the
  // generate flow doesn't fall back to claude/codex when hermes is installed.
  const exists = deps.existsSync ?? fs.existsSync
  const home = (deps.homedir ?? os.homedir)()
  for (const candidate of hermesCandidatePaths(home, deps.platform ?? process.platform, deps.env ?? process.env)) {
    if (exists(candidate)) return { name: "hermes", detail: candidate }
  }
  return null
}

function hermesCandidatePaths(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  // Use platform-specific path joiners so a unit test on macOS can still
  // assert Windows install layouts deterministically.
  if (platform === "win32") {
    const j = path.win32.join
    const appdata = env.APPDATA ?? j(home, "AppData", "Roaming")
    const localappdata = env.LOCALAPPDATA ?? j(home, "AppData", "Local")
    const out: string[] = []
    // pipx — clean per-package venv, increasingly recommended for CLI tools.
    out.push(j(localappdata, "pipx", "venvs", "hermes-agent", "Scripts", "hermes.exe"))
    // Per-user pip (`pip install --user`, the default for non-admin Python on Win 10/11).
    // Covers Python 3.9–3.14 install layouts.
    for (const v of ["39", "310", "311", "312", "313", "314"]) {
      out.push(j(appdata, "Python", `Python${v}`, "Scripts", "hermes.exe"))
      out.push(j(localappdata, "Programs", "Python", `Python${v}`, "Scripts", "hermes.exe"))
      out.push(j(localappdata, "Programs", "Python", `Python${v}-32`, "Scripts", "hermes.exe"))
      out.push(`C:\\Python${v}\\Scripts\\hermes.exe`)
    }
    // PEP 370 user-scripts on Windows 10+ (only present when explicitly enabled).
    out.push(j(home, ".local", "bin", "hermes.exe"))
    // Conda / Miniforge.
    out.push(j(home, "miniconda3", "Scripts", "hermes.exe"))
    out.push(j(home, "anaconda3", "Scripts", "hermes.exe"))
    out.push(j(home, "miniforge3", "Scripts", "hermes.exe"))
    return out
  }
  const j = path.posix.join
  return [
    j(home, ".local", "bin", "hermes"),
    j(home, ".local", "pipx", "venvs", "hermes-agent", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
    j(home, ".pyenv", "shims", "hermes"),
  ]
}

export async function detectClaude(deps: DetectionDeps = {}): Promise<DetectedAgent | null> {
  const home = (deps.homedir ?? os.homedir)()
  const exists = deps.existsSync ?? fs.existsSync
  const which = deps.which ?? defaultWhich
  const dir = path.join(home, ".claude")
  if (exists(dir)) {
    const cli = which("claude")
    if (cli) return { name: "claude", detail: cli }
    return { name: "claude", detail: dir }
  }
  return null
}

export async function detectCodex(deps: DetectionDeps = {}): Promise<DetectedAgent | null> {
  const home = (deps.homedir ?? os.homedir)()
  const exists = deps.existsSync ?? fs.existsSync
  const which = deps.which ?? defaultWhich
  const auth = path.join(home, ".codex", "auth.json")
  if (exists(auth)) {
    const cli = which("codex")
    if (cli) return { name: "codex", detail: cli }
    return { name: "codex", detail: auth }
  }
  return null
}

export async function detectAgents(deps: DetectionDeps = {}): Promise<DetectedAgent[]> {
  const results: DetectedAgent[] = []
  const h = await detectHermes(deps)
  if (h) results.push(h)
  const c = await detectClaude(deps)
  if (c) results.push(c)
  const x = await detectCodex(deps)
  if (x) results.push(x)
  return results
}

export interface InvokeOptions {
  cwd: string
  prompt: string
  onChunk?: (text: string) => void
}

export async function invokeAgent(agent: DetectedAgent, opts: InvokeOptions): Promise<{ ok: boolean; error?: string }> {
  if (agent.name === "claude") return invokeClaude(agent, opts)
  if (agent.name === "codex") return invokeCodex(agent, opts)
  if (agent.name === "hermes") return invokeHermes(agent, opts)
  return { ok: false, error: `Unknown agent: ${agent.name}` }
}

function streamChild(
  cmd: string,
  args: string[],
  cwd: string,
  onChunk?: (s: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    // If the caller provides onChunk, *they* own rendering (e.g. they're
    // drawing a spinner around the stream and need to know when bytes arrive
    // to clear it). Falling back to direct stdout.write preserves the old
    // behavior for any caller that just wants the output verbatim.
    const write = (s: string) => {
      if (onChunk) onChunk(s)
      else process.stdout.write(s)
    }
    child.stdout.on("data", (d) => write(d.toString()))
    child.stderr.on("data", (d) => write(d.toString()))
    child.on("error", (err) => resolve({ ok: false, error: err.message }))
    child.on("close", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: `${path.basename(cmd)} exited with code ${code}` }),
    )
  })
}

async function invokeClaude(agent: DetectedAgent, opts: InvokeOptions): Promise<{ ok: boolean; error?: string }> {
  const cli = agent.detail.endsWith("claude") || agent.detail.includes("/bin/") ? agent.detail : "claude"
  // `claude -p` runs a one-shot, non-interactive prompt that streams to stdout.
  // `--permission-mode bypassPermissions` skips the interactive Edit/Write/Bash
  // approval gate — required for headless use. The user explicitly invoked
  // `--generate` knowing it will modify the scaffold, so this is a fair trade.
  return streamChild(cli, ["-p", "--permission-mode", "bypassPermissions", opts.prompt], opts.cwd, opts.onChunk)
}

async function invokeCodex(agent: DetectedAgent, opts: InvokeOptions): Promise<{ ok: boolean; error?: string }> {
  const cli = agent.detail.endsWith("codex") || agent.detail.includes("/bin/") ? agent.detail : "codex"
  // `codex exec` is non-interactive. `--full-auto` (Codex CLI 0.30+) skips
  // approval prompts in the same spirit as Claude's bypassPermissions.
  return streamChild(cli, ["exec", "--full-auto", opts.prompt], opts.cwd, opts.onChunk)
}

async function invokeHermes(agent: DetectedAgent, opts: InvokeOptions): Promise<{ ok: boolean; error?: string }> {
  // `hermes -z "<prompt>"` runs a non-interactive one-shot and streams the
  // response to stdout. Uses hermes's own configured credentials — no API
  // key wiring inside pond.
  return streamChild(agent.detail, ["-z", opts.prompt], opts.cwd, opts.onChunk)
}
