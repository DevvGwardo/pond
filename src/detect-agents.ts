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
  return streamChild(cli, ["-p", opts.prompt], opts.cwd, opts.onChunk)
}

async function invokeCodex(agent: DetectedAgent, opts: InvokeOptions): Promise<{ ok: boolean; error?: string }> {
  const cli = agent.detail.endsWith("codex") || agent.detail.includes("/bin/") ? agent.detail : "codex"
  // `codex exec "<prompt>"` runs a non-interactive Codex CLI session.
  return streamChild(cli, ["exec", opts.prompt], opts.cwd, opts.onChunk)
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
