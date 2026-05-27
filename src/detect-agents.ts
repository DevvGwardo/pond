import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as readline from "node:readline"
import { spawn } from "node:child_process"

export type AgentName = "hermes" | "claude" | "codex"

export interface DetectedAgent {
  name: AgentName
  detail: string
}

interface DetectionDeps {
  fetch?: typeof fetch
  homedir?: () => string
  existsSync?: typeof fs.existsSync
  which?: (cmd: string) => string | null
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
  const f = deps.fetch ?? fetch
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 350)
    const res = await f("http://127.0.0.1:8642/v1/models", { signal: ac.signal })
    clearTimeout(t)
    // Only count hermes as usable if the endpoint answers cleanly. A 401/403
    // means there's a server listening but it requires credentials we don't
    // have — falling through to the next agent in the cascade is cheaper
    // than failing the whole `--generate` call.
    if (res.ok || res.status === 404 || res.status === 405) {
      return { name: "hermes", detail: "http://127.0.0.1:8642" }
    }
  } catch {
    // not running
  }
  return null
}

// Look for evidence that hermes-agent is *installed* on this machine even when
// the gateway isn't currently running on 8642. We use this to tell the user
// "hey, you could start your local agent" instead of silently falling back to
// a remote model. Returns the discovered path (binary or config dir) or null.
export function detectHermesInstall(deps: DetectionDeps = {}): string | null {
  const home = (deps.homedir ?? os.homedir)()
  const exists = deps.existsSync ?? fs.existsSync
  const which = deps.which ?? defaultWhich
  // Binary on PATH wins — that's the actionable "start it" hint.
  for (const candidate of ["hermes-agent", "hermes"]) {
    const found = which(candidate)
    if (found) return found
  }
  // Otherwise check the common config dirs.
  for (const rel of [".hermes-agent", ".hermes", ".config/hermes-agent", ".config/hermes"]) {
    const abs = path.join(home, rel)
    if (exists(abs)) return abs
  }
  return null
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
    const write = (s: string) => {
      onChunk?.(s)
      process.stdout.write(s)
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

async function invokeHermes(_agent: DetectedAgent, opts: InvokeOptions): Promise<{ ok: boolean; error?: string }> {
  // Hermes serves an OpenAI-compatible chat API at 127.0.0.1:8642.
  // We stream a single turn and write tokens to stdout as they arrive.
  try {
    const res = await fetch("http://127.0.0.1:8642/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "hermes",
        stream: true,
        messages: [
          {
            role: "system",
            content:
              "You are coding inside a pond capsule scaffold. Read AGENTS.md, then edit server/index.ts and client/index.tsx to satisfy the user's prompt. Print the edits inline.",
          },
          { role: "user", content: opts.prompt },
        ],
      }),
    })
    if (!res.ok || !res.body) return { ok: false, error: `hermes responded ${res.status}` }

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split("\n\n")
      buf = parts.pop() ?? ""
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"))
        if (!line) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        try {
          const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
          const tok = j.choices?.[0]?.delta?.content
          if (tok) {
            opts.onChunk?.(tok)
            process.stdout.write(tok)
          }
        } catch {
          // skip malformed chunk
        }
      }
    }
    process.stdout.write("\n")
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Ask the user a y/n question on stdin. Returns the default when stdin isn't
// a TTY (so scripted invocations of `pond new --generate` stay deterministic).
export function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(defaultYes)
  const hint = defaultYes ? "[Y/n]" : "[y/N]"
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<boolean>((resolve) => {
    rl.question(`${question} ${hint} `, (answer) => {
      rl.close()
      const trimmed = (answer ?? "").trim().toLowerCase()
      if (!trimmed) return resolve(defaultYes)
      resolve(trimmed === "y" || trimmed === "yes")
    })
  })
}

// Start a detached hermes-agent process and poll /v1/models until it answers
// or we hit the timeout. The child is intentionally detached + stdio:'ignore'
// so the gateway outlives the pond invocation that started it. Returns the
// resolved DetectedAgent on success, or null on timeout / spawn failure.
export async function startHermesGateway(
  binary: string,
  opts: { timeoutMs?: number; onLine?: (s: string) => void } = {},
): Promise<DetectedAgent | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const logFile = path.join(os.tmpdir(), `pond-hermes-${Date.now()}-${process.pid}.log`)
  let fd: number
  try {
    fd = fs.openSync(logFile, "a")
  } catch (err) {
    opts.onLine?.(`failed to open log file: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  let child
  try {
    // We try `<binary> serve` first; if that exits >0 within 2s the operator
    // probably uses a different verb — but we can't know without spec. Let
    // the gateway authors document POND_HERMES_START_ARGS to override.
    const startArgs = (process.env.POND_HERMES_START_ARGS ?? "serve").split(/\s+/).filter(Boolean)
    child = spawn(binary, startArgs, {
      detached: true,
      stdio: ["ignore", fd, fd],
    })
    child.unref()
  } catch (err) {
    fs.closeSync(fd)
    opts.onLine?.(`spawn failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  opts.onLine?.(`spawned ${binary} ${process.env.POND_HERMES_START_ARGS ?? "serve"} (log: ${logFile})`)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300))
    const found = await detectHermes()
    if (found) {
      try {
        fs.closeSync(fd)
      } catch {
        // best effort
      }
      return found
    }
  }
  try {
    fs.closeSync(fd)
  } catch {
    // best effort
  }
  opts.onLine?.(`gateway did not respond within ${(timeoutMs / 1000).toFixed(0)}s — see ${logFile}`)
  return null
}
