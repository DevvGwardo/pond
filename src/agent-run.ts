import * as fs from "node:fs"
import * as path from "node:path"
import { invokeAgent, type AgentEvent, type DetectedAgent } from "./detect-agents.js"

// Shared agent-driving loop used by `pond new --generate` and `pond edit`.
// Both flows: detect agents, hand a prompt to the first that works, render a
// live activity panel (claude streams structured events; codex/hermes stream
// raw text), and treat "exited clean but changed nothing" as a failure so the
// cascade moves on to the next detected agent.

function describeTool(tool: string, target?: string): string {
  // Map Claude's tool names to human-readable verbs. Default to "<tool>: <target>"
  // for tools we don't have a custom phrasing for so unknown tools still render.
  const t = target ? target.replace(/\n/g, " ").slice(0, 80) : undefined
  switch (tool) {
    case "Read":
      return t ? `Reading ${t}` : "Reading file"
    case "Edit":
    case "MultiEdit":
      return t ? `Editing ${t}` : "Editing file"
    case "Write":
      return t ? `Writing ${t}` : "Writing file"
    case "Bash":
      return t ? `Running: ${t}` : "Running command"
    case "Glob":
      return t ? `Searching: ${t}` : "Searching files"
    case "Grep":
      return t ? `Searching for "${t}"` : "Searching"
    case "WebFetch":
    case "WebSearch":
      return t ? `Fetching ${t}` : "Fetching web"
    case "TodoWrite":
      return "Updating plan"
    default:
      return t ? `${tool}: ${t}` : tool
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

// Recursively map every source file under the given roots to its byte size.
// Roots may be files (snapshotted directly) or directories (walked). Build
// artifacts and VCS/runtime dirs are skipped so they never count as "the agent
// changed something". Used to prove the agent actually wrote code before we
// report success.
const SNAPSHOT_SKIP = new Set(["node_modules", ".pond", ".git"])

function snapshotSizes(roots: string[]): Map<string, number> {
  const sizes = new Map<string, number>()
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (SNAPSHOT_SKIP.has(entry.name)) continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(p)
      } else if (entry.isFile()) {
        try {
          sizes.set(p, fs.statSync(p).size)
        } catch {
          // disappeared mid-walk — ignore
        }
      }
    }
  }
  for (const root of roots) {
    try {
      const st = fs.statSync(root)
      if (st.isDirectory()) walk(root)
      else if (st.isFile()) sizes.set(root, st.size)
    } catch {
      // missing root — ignore
    }
  }
  return sizes
}

// Count files whose size changed, or that appeared / disappeared, between two
// snapshots.
function countChanged(before: Map<string, number>, after: Map<string, number>): number {
  let n = 0
  for (const [p, size] of after) {
    if (before.get(p) !== size) n++
  }
  for (const p of before.keys()) {
    if (!after.has(p)) n++
  }
  return n
}

function totalBytes(sizes: Map<string, number>): number {
  let n = 0
  for (const v of sizes.values()) n += v
  return n
}

export interface AgentTaskOptions {
  cwd: string
  prompt: string
  // Non-empty, pre-detected and ordered by preference. The loop cascades
  // through these until one succeeds.
  detected: DetectedAgent[]
  // Files and/or directories whose contents prove the agent did work. The loop
  // snapshots them before/after each agent; an agent that exits 0 without
  // changing any of them is treated as a failure (so we fall through).
  watchRoots: string[]
  // Gerund shown in the live panel: "building" (new) / "editing" (edit).
  verb?: string
}

export interface AgentTaskResult {
  success: boolean
  agentName?: string
  // Number of source files the winning agent changed (0 when no agent won).
  changedFiles: number
  errors: Array<{ name: string; error: string }>
}

export async function runAgentTask(opts: AgentTaskOptions): Promise<AgentTaskResult> {
  const { cwd, prompt, detected, watchRoots } = opts
  const verb = opts.verb ?? "working"
  const errors: Array<{ name: string; error: string }> = []
  const isTty = process.stdout.isTTY === true
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

  for (const candidate of detected) {
    const baseline = snapshotSizes(watchRoots)
    const baselineTotal = totalBytes(baseline)
    const startedAt = Date.now()
    let toolCount = 0
    let lastActivity = `${candidate.name} starting up…`
    let frameIdx = 0
    let drawnLines = 0
    let timer: NodeJS.Timeout | null = null
    const supportsLiveEvents = candidate.name === "claude"

    const draw = () => {
      if (!isTty) return
      if (drawnLines > 0) process.stdout.write(`\x1b[${drawnLines}F\x1b[J`)
      const spin = spinnerFrames[frameIdx % spinnerFrames.length]
      const now = snapshotSizes(watchRoots)
      const changed = countChanged(baseline, now)
      const delta = totalBytes(now) - baselineTotal
      const sourceLine =
        changed === 0
          ? `    source unchanged (${fmtBytes(totalBytes(now))})`
          : `    ${changed} file${changed === 1 ? "" : "s"} changed    ${delta >= 0 ? "+" : ""}${fmtBytes(Math.abs(delta))}`
      // Clip each line to the terminal width so a wrapped line doesn't leave
      // stale rows behind on redraw (the cursor only moves up by logical-line
      // count). Same guard as the original `pond new --generate` panel.
      const maxW = Math.max(1, (process.stdout.columns ?? 80) - 1)
      const clip = (s: string) => (s.length > maxW ? s.slice(0, maxW - 1) + "…" : s)
      const lines = [
        `  ${spin} ${candidate.name} is ${verb}… ${fmtElapsed(Date.now() - startedAt)}` +
          (toolCount > 0 ? `  (${toolCount} action${toolCount === 1 ? "" : "s"})` : ""),
        `    ▸ ${lastActivity}`,
        sourceLine,
      ].map(clip)
      process.stdout.write(lines.join("\n") + "\n")
      drawnLines = lines.length
    }

    const eraseLive = () => {
      if (isTty && drawnLines > 0) {
        process.stdout.write(`\x1b[${drawnLines}F\x1b[J`)
        drawnLines = 0
      }
    }

    if (isTty) {
      draw()
      timer = setInterval(() => {
        frameIdx++
        draw()
      }, 200)
    } else {
      console.log(`\n  ${capitalize(verb)} with ${candidate.name} (this can take 1–3 minutes)…`)
    }

    const onEvent = (e: AgentEvent) => {
      if (e.kind === "tool") {
        toolCount++
        lastActivity = describeTool(e.tool, e.target)
        if (!isTty) console.log(`  [${fmtElapsed(Date.now() - startedAt)}] ${lastActivity}`)
      } else if (e.kind === "text") {
        lastActivity = e.text.split("\n")[0].slice(0, 100)
      } else if (e.kind === "info") {
        lastActivity = e.message
      }
      if (isTty) draw()
    }

    let streamedBytes = 0
    // codex/hermes don't stream structured events yet — show raw chunks so the
    // user still sees progress.
    const onChunk = (s: string) => {
      streamedBytes += Buffer.byteLength(s, "utf-8")
      if (supportsLiveEvents) return // claude's live panel owns the display
      if (isTty) eraseLive()
      process.stdout.write(s)
    }

    const result = await invokeAgent(candidate, {
      cwd,
      prompt,
      onChunk,
      onEvent: supportsLiveEvents ? onEvent : undefined,
    })
    if (timer) clearInterval(timer)
    eraseLive()

    if (result.ok) {
      const after = snapshotSizes(watchRoots)
      const changed = countChanged(baseline, after)
      // A clean exit is not proof of work: an agent whose own LLM call fails
      // (e.g. a 404 from its backend) can still exit 0 and touch nothing. Treat
      // "exited ok but changed nothing" as a failure so we cascade.
      if (changed === 0) {
        errors.push({ name: candidate.name, error: "exited without changing any source files" })
        console.error(`\n  ${candidate.name} made no changes — treating as failure`)
        const remaining = detected.slice(detected.indexOf(candidate) + 1)
        if (remaining.length) {
          console.error(`  Falling back to: ${remaining.map((a) => a.name).join(" → ")}`)
        }
        continue
      }
      const summary = supportsLiveEvents
        ? ` — ${toolCount} action${toolCount === 1 ? "" : "s"}`
        : streamedBytes > 0
          ? ` — ${(streamedBytes / 1024).toFixed(1)} KB streamed`
          : ""
      console.log(`\n  ${candidate.name} finished in ${fmtElapsed(Date.now() - startedAt)}${summary}`)
      console.log(`    ${changed} file${changed === 1 ? "" : "s"} changed`)
      return { success: true, agentName: candidate.name, changedFiles: changed, errors }
    }

    errors.push({ name: candidate.name, error: result.error ?? "unknown" })
    console.error(`\n  ${candidate.name} failed: ${result.error}`)
    const remaining = detected.slice(detected.indexOf(candidate) + 1)
    if (remaining.length) {
      console.error(`  Falling back to: ${remaining.map((a) => a.name).join(" → ")}`)
    }
  }

  return { success: false, changedFiles: 0, errors }
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}
