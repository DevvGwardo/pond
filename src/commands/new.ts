import { defineCommand } from "citty"
import * as path from "node:path"
import { copyTemplate } from "../template.js"
import { TEMPLATES, getTemplate } from "../templates.js"
import { detectAgents, invokeAgent, type DetectedAgent } from "../detect-agents.js"

const SLUG_RE = /^[a-z][a-z0-9_-]*$/i
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "with",
  "to",
  "in",
  "of",
  "on",
  "my",
  "our",
  "app",
  "site",
  "thing",
  "build",
  "make",
  "create",
  "new",
])

function slugify(input: string, max = 40): string {
  const lowered = input.toLowerCase().replace(/[^a-z0-9\s-]+/g, " ")
  const tokens = lowered.split(/\s+/).filter(Boolean)
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t))
  const source = meaningful.length ? meaningful : tokens
  const slug = source.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "")
  return (slug || "capsule").slice(0, max).replace(/-$/, "")
}

export const newCommand = defineCommand({
  meta: {
    name: "new",
    description: "Create a new pond capsule. Pass a name or a free-form description of what to build.",
  },
  args: {
    name: {
      type: "positional",
      description: "Capsule name (single token) or first word of a description",
      required: false,
    },
    name_flag: {
      type: "string",
      description: "Override the auto-derived directory name when using a prompt",
      alias: ["dir"],
    },
    template: {
      type: "string",
      description: "Template to use (default: auto-pick from prompt, else 'todo')",
    },
    git: {
      type: "boolean",
      description: "Initialize a git repo in the new capsule (use --no-git to skip)",
      default: true,
    },
    generate: {
      type: "boolean",
      description:
        "After scaffolding, invoke a locally detected coding agent (hermes → claude → codex) to build the app from the prompt",
      default: false,
    },
    "list-templates": {
      type: "boolean",
      description: "List all available templates and exit",
      default: false,
    },
  },
  async run({ args }) {
    if ((args as unknown as { "list-templates"?: boolean })["list-templates"]) {
      console.log("\n  Available templates:\n")
      const pad = Math.max(...TEMPLATES.map((t) => t.name.length))
      for (const t of TEMPLATES) {
        console.log(`    ${t.name.padEnd(pad)}  ${t.description}`)
      }
      console.log()
      return
    }

    const positionals: string[] = ((args as unknown as { _?: string[] })._ ?? []).map(String)

    let name: string
    let promptText: string | undefined

    const explicitName =
      (args as unknown as { name_flag?: string; dir?: string }).name_flag ??
      (args as unknown as { name_flag?: string; dir?: string }).dir

    const isSingleSlug = positionals.length === 1 && SLUG_RE.test(positionals[0]) && !positionals[0].includes(" ")

    if (positionals.length === 0) {
      console.error("Pass a name (pond new my-app) or a description (pond new a dashboard for hermes-agent)")
      process.exit(1)
    }
    if (isSingleSlug && !explicitName) {
      name = positionals[0]
    } else {
      promptText = positionals.join(" ").trim()
      name = explicitName ?? slugify(promptText)
    }

    const templateArg = (args as { template?: string }).template
    const wantsGenerate = Boolean((args as { generate?: boolean }).generate)

    // Detect local agents on every run (informational unless --generate is set)
    const detected: DetectedAgent[] = await detectAgents()
    if (detected.length) {
      const lead = detected[0]
      const others = detected
        .slice(1)
        .map((d) => d.name)
        .join(", ")
      const tail = others ? ` (also: ${others})` : ""
      console.log(`  Detected agent: ${lead.name} — ${lead.detail}${tail}`)
    }

    const requestedTemplate = templateArg ?? (promptText ? undefined : "todo")
    if (requestedTemplate && !getTemplate(requestedTemplate)) {
      console.error(`Unknown template: ${requestedTemplate}. Try --list-templates for the registry.`)
      process.exit(1)
    }

    // With --generate, the agent rewrites both files from scratch. Skip the
    // template lookup and scaffold a blank-canvas stub so the user's prompt
    // drives 100% of the app instead of "template + agent overlay". The user
    // can still force a starting template by passing --template explicitly.
    const useStub = wantsGenerate && !templateArg

    const { template } = await copyTemplate({
      name,
      templateName: requestedTemplate ?? "todo",
      initGit: Boolean(args.git),
      prompt: promptText,
      useStub,
    })

    if (template) {
      console.log(`\n  Created ${name}/ (template: ${template.name})`)
    } else {
      console.log(`\n  Created ${name}/ (stub scaffold — agent will design from your prompt)`)
    }
    if (promptText) {
      console.log(`  Wrote AGENTS.md and .claude/CLAUDE.md with your prompt.`)
    }

    if (wantsGenerate) {
      if (!promptText) {
        console.error('\n  --generate requires a prompt. Try: pond new "<description>" --generate')
        process.exit(1)
      }
      if (!detected.length) {
        console.error(
          "\n  --generate: no local agent detected (looked for `hermes` on PATH, ~/.claude, ~/.codex/auth.json).",
        )
        console.error(`  AGENTS.md remains in ${name}/ — install hermes / claude / codex and re-run.`)
        process.exit(1)
      }
      // Cascade through every detected agent. Detection passing for hermes
      // doesn't guarantee the model is loaded or the token is valid, so a
      // failure on the first candidate falls through to the next instead of
      // wasting the scaffold.
      const projDir = path.resolve(process.cwd(), name)
      const generatePrompt = `Read AGENTS.md in the current directory and follow the build instructions. Edit server/index.ts and client/index.tsx in place.`
      const errors: Array<{ name: string; error: string }> = []
      let success = false
      for (const candidate of detected) {
        console.log(`\n  Streaming output from ${candidate.name}...\n`)
        const result = await invokeAgent(candidate, { cwd: projDir, prompt: generatePrompt })
        if (result.ok) {
          success = true
          break
        }
        errors.push({ name: candidate.name, error: result.error ?? "unknown" })
        console.error(`\n  ${candidate.name} failed: ${result.error}`)
        const remaining = detected.slice(detected.indexOf(candidate) + 1)
        if (remaining.length) {
          console.error(`  Falling back to: ${remaining.map((a) => a.name).join(" → ")}`)
        }
      }
      if (!success) {
        console.error(
          `\n  --generate: all detected agents failed (${errors.map((e) => `${e.name}: ${e.error}`).join("; ")}).`,
        )
        console.error(`  AGENTS.md preserved in ${name}/ — fix one of the agents and re-run.`)
        process.exit(1)
      }
      console.log(`\n  Agent finished. Review the changes, then:`)
      console.log(`    cd ${name}`)
      console.log(`    npm install && npm run dev`)
      console.log()
      return
    }

    console.log(`\n  Next steps:`)
    console.log(`    cd ${name}`)
    console.log(`    npm install`)
    if (promptText) {
      console.log(`    claude   # or: cursor . — your agent will read AGENTS.md and build`)
      if (detected.length) {
        console.log(`    pond new ... --generate     # or rerun with --generate to invoke ${detected[0].name} directly`)
      }
    } else {
      console.log(`    npm run dev`)
    }
    console.log()
  },
})
