import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { detectAgents, type AgentName, type DetectedAgent } from "../detect-agents.js"
import { runAgentTask } from "../agent-run.js"

const AGENT_NAMES: AgentName[] = ["hermes", "claude", "codex"]

export const editCommand = defineCommand({
  meta: {
    name: "edit",
    description: "Ask a local agent to add a feature or make changes to the capsule in the current directory.",
  },
  args: {
    request: {
      type: "positional",
      required: false,
      description: 'What to change or add, e.g. pond edit "add a dark mode toggle and persist it"',
    },
    agent: {
      type: "string",
      description: "Force a specific agent (hermes | claude | codex) instead of the auto-detect cascade",
    },
  },
  async run({ args }) {
    const cwd = process.cwd()
    const serverFile = path.join(cwd, "server", "index.ts")
    const clientFile = path.join(cwd, "client", "index.tsx")
    const sharedDir = path.join(cwd, "shared")

    // Same capsule-root check `pond dev` uses: server/index.ts is the entry.
    if (!fs.existsSync(serverFile)) {
      console.error(`No server/index.ts found in ${cwd}.`)
      console.error("  Run `pond edit` from inside a capsule, or scaffold one first: pond new <name>")
      process.exit(1)
    }

    const positionals: string[] = ((args as unknown as { _?: string[] })._ ?? []).map(String)
    const request = positionals.join(" ").trim()
    if (!request) {
      console.error('pond edit requires a description of the change. Try: pond edit "add a search box to the list"')
      process.exit(1)
    }

    let detected: DetectedAgent[] = await detectAgents()

    const forced = (args as { agent?: string }).agent
    if (forced) {
      const want = forced.toLowerCase()
      if (!AGENT_NAMES.includes(want as AgentName)) {
        console.error(`Unknown agent "${forced}". Choose one of: ${AGENT_NAMES.join(", ")}`)
        process.exit(1)
      }
      const match = detected.find((d) => d.name === want)
      if (!match) {
        const found = detected.length ? detected.map((d) => d.name).join(", ") : "none"
        console.error(`Agent "${want}" not detected on this machine (detected: ${found}).`)
        process.exit(1)
      }
      detected = [match]
    }

    if (!detected.length) {
      console.error(
        "\n  pond edit: no local agent detected (looked for `hermes` on PATH, ~/.claude, ~/.codex/auth.json).",
      )
      console.error("  Install hermes / claude / codex and re-run.")
      process.exit(1)
    }

    const lead = detected[0]
    const others = detected
      .slice(1)
      .map((d) => d.name)
      .join(", ")
    console.log(`  Editing this capsule with ${lead.name}${others ? ` (fallbacks: ${others})` : ""}`)
    console.log(`  Request: ${request}`)

    // The agent runs headlessly against an existing capsule. It must read the
    // current code + the always-scaffolded contract (.claude/CLAUDE.md) before
    // editing, preserve working features, and — as in `pond new --generate` —
    // not try to boot/verify the app (the user may already have `pond dev`
    // running with hot reload; a background server it spawns would leak).
    const editPrompt = [
      "You are modifying an EXISTING pond capsule in the current directory. Do not scaffold a new project.",
      "",
      "The user's change request:",
      `> ${request.replace(/\n/g, "\n> ")}`,
      "",
      "First read these for context, then make the change by editing them in place:",
      "- server/index.ts — the capsule definition (schema, queries, mutations)",
      "- client/index.tsx — the Preact UI",
      "- any files under shared/",
      "- .claude/CLAUDE.md — the pond capsule contract (server + client API and design rules)",
      "",
      "Implement the request: add or adjust tables, queries, mutations, and UI as needed. PRESERVE existing working features unless the request asks you to change or remove them. Keep everything in server/index.ts and client/index.tsx; add files under shared/ only if both sides import them. Follow the capsule contract and its design rules.",
      "",
      "HARD RULES (do not violate):",
      "- Do NOT run `npm install`. Do NOT run `npm run dev` / `pond dev` / any dev server, foreground or background.",
      "- Do NOT curl, fetch, or hit localhost to verify — assume the dev server may already be running with hot reload.",
      "- Do NOT loop trying to test the app. Make the edits and stop.",
      "- Stop as soon as the change is implemented and the files look correct on a read-through. You are running headlessly; there is no browser and no human to ask.",
    ].join("\n")

    const result = await runAgentTask({
      cwd,
      prompt: editPrompt,
      detected,
      // Proof-of-work: the agent must touch at least one of these. shared/ is a
      // directory so newly-created shared modules count too.
      watchRoots: [serverFile, clientFile, sharedDir],
      verb: "editing",
    })

    if (!result.success) {
      console.error(
        `\n  pond edit: ${forced ? `${forced} failed` : "all detected agents failed"} (${result.errors
          .map((e) => `${e.name}: ${e.error}`)
          .join("; ")}).`,
      )
      console.error("  Your capsule is unchanged. Fix the agent (or pass --agent) and re-run.")
      process.exit(1)
    }

    console.log(`\n  Done. Review the diff, then:`)
    console.log(`    pond dev        # if it isn't already running — changes hot-reload`)
    console.log(`    pond deploy     # ship the update`)
    console.log()
  },
})
