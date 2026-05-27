import { defineCommand } from "citty"
import { copyTemplate } from "../template.js"

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
      required: true,
    },
    name_flag: {
      type: "string",
      description: "Override the auto-derived directory name when using a prompt",
      alias: ["dir"],
    },
    template: {
      type: "string",
      description: "Template to use (default: todo)",
      default: "todo",
    },
    git: {
      type: "boolean",
      description: "Initialize a git repo in the new capsule (use --no-git to skip)",
      default: true,
    },
  },
  async run({ args }) {
    const positionals: string[] = ((args as unknown as { _?: string[] })._ ?? []).map(String)

    let name: string
    let promptText: string | undefined

    const explicitName =
      (args as unknown as { name_flag?: string; dir?: string }).name_flag ??
      (args as unknown as { name_flag?: string; dir?: string }).dir

    const isSingleSlug = positionals.length === 1 && SLUG_RE.test(positionals[0]) && !positionals[0].includes(" ")

    if (isSingleSlug && !explicitName) {
      name = positionals[0]
    } else {
      promptText = positionals.join(" ").trim()
      if (!promptText) {
        console.error("Pass a name (pond new my-app) or a description (pond new a dashboard for hermes-agent)")
        process.exit(1)
      }
      name = explicitName ?? slugify(promptText)
    }

    await copyTemplate(name, args.template, Boolean(args.git), promptText)
    console.log(`\n  Created ${name}/`)
    if (promptText) {
      console.log(`  Wrote AGENTS.md and .claude/CLAUDE.md with your prompt.`)
    }
    console.log(`\n  Next steps:`)
    console.log(`    cd ${name}`)
    console.log(`    npm install`)
    if (promptText) {
      console.log(`    claude   # or: cursor . — your agent will read AGENTS.md and build`)
    } else {
      console.log(`    npm run dev`)
    }
    console.log()
  },
})
