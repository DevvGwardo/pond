import * as fs from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  getTemplate,
  pickTemplateForPrompt,
  STUB_CLIENT_TSX,
  STUB_SERVER_TS,
  TEMPLATES,
  Template,
} from "./templates.js"

const POND_VERSION = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf-8"))
  .version as string

const BASE_ENV_TEMPLATE = `# Server-only environment variables
# POND_SESSION_SECRET={{SESSION_SECRET}}
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-...
# HERMES_BASE_URL=http://127.0.0.1:8642
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# GITHUB_REDIRECT_URI=http://localhost:3000/auth/github/callback
# EMAIL_FROM=
# RESEND_API_KEY=
`

const GITIGNORE = `node_modules
.pond
`

const CAPSULE_CONTRACT = `## Pond capsule contract

A pond capsule is one server file + one client file + a shared dir.

### server/index.ts

\`\`\`ts
import { capsule, mutation, query, table, string, number, boolean } from "pond/server"

export default capsule({
  schema: {
    items: table({ body: string(), done: boolean() }),
  },
  queries: {
    items: query((ctx) => ctx.db.items.orderBy("createdAt", "desc").all()),
  },
  mutations: {
    addItem: mutation((ctx, body: string) => ctx.db.items.insert({ body, done: false })),
    toggleItem: mutation((ctx, id: string) => {
      const row = ctx.db.items.get(id)
      if (row) ctx.db.items.update(id, { done: !row.done })
    }),
  },
})
\`\`\`

Every table auto-gets \`id\` (uuid), \`createdAt\`, \`updatedAt\`. Column helpers: \`string()\`, \`number()\`, \`boolean()\`. SQLite under the hood — booleans round-trip as 0/1.

\`ctx.db.<table>\` exposes \`.all() / .get(id) / .where(col, val) / .orderBy(col, dir) / .limit(n) / .insert({...}) / .update(id, {...}) / .delete(id)\`.

Queries and mutations both take \`(ctx, ...args)\` — the args after \`ctx\` are the wire payload. Queries re-run reactively on the client whenever a mutation completes.

\`ctx.ai\`, \`ctx.blob\` and per-route \`rateLimit\` are first-class — see https://pond.run/docs/api-reference.md.

### client/index.tsx

Preact + Tailwind classes (use \`class\` not \`className\`). Use \`useQuery<T, Args>(name, ...args)\` and \`useMutation<Args, Ret>(name)\` from \`"pond/client"\`. Queries can take args — pass them after the name and they're spread into the server handler.

\`\`\`tsx
import { useMutation, useQuery } from "pond/client"

export function App({ itemId }: { itemId: string }) {
  const { data, isLoading } = useQuery<Item[]>("items")               // no-arg: GET
  const { data: item } = useQuery<Item, [string]>("itemById", itemId) // arg'd: POST { args: [itemId] }
  const [addItem] = useMutation<[body: string], void>("addItem")
  return <main>…</main>
}
\`\`\`

### Running it

- \`npm install\` then \`npm run dev\` — local dev with hot reload at http://localhost:3000
- \`npm run deploy\` — anonymous deploy. You get a URL + a one-time claim token.

### Rules of thumb

- Keep everything in \`server/index.ts\` and \`client/index.tsx\`. Add files under \`shared/\` only if both sides import them.
- No separate API layer. Define mutations/queries on the server; call them by name from the client.
- No \`fetch\` from the client to your own server — use \`useQuery\` / \`useMutation\`.
- Tailwind classes are available out of the box (Tailwind v3 via CDN); no config needed. Use raw Tailwind utilities — there are **no preset \`.btn\` / \`.card\` / \`.input\` classes** and you should not invent any.
- **Design intentionally — do not produce the AI default.** A pond capsule that looks like every other Claude/Cursor demo is a bug. Specifically avoid:
  - \`bg-zinc-950\` plus \`bg-zinc-900 border border-zinc-800 rounded-lg\` card stacks. Pick \`bg-black\` or a non-zinc neutral, and use \`divide-y\` / \`border-y\` rows or borderless lists instead of card-per-item.
  - The white-filled pill button (\`bg-zinc-100 text-zinc-950 rounded-lg px-5 py-3 font-semibold\`). Prefer wireframe buttons (\`border border-white px-4 py-2 font-medium\`) or a real brand color — never the universal AI-default white pill.
  - One font-family everywhere. Sprinkle \`font-mono\` on timestamps, indices, source tags, IDs — anything machine-flavored.
  - Timid \`text-2xl\` page titles. Page titles are display type: \`text-4xl\` / \`text-5xl\` \`font-bold tracking-tight\` minimum.
  - \`rounded-lg\` on everything. Square corners (no \`rounded-*\` except round avatars) read as intentional; universally rounded reads as defaulted.
- Each capsule should have **one signature move** — a single deliberate choice that makes it not look templated. Examples: numbered mono indices on list rows, oversized \`tabular-nums\` numbers, a serif body type, a bottom-anchored composer, a colored source tag.
`

function agentsMdContent(prompt: string, templateName: string): string {
  const starter =
    templateName === "stub"
      ? `\`server/index.ts\` and \`client/index.tsx\` are empty stubs. Replace them entirely with an implementation that matches the description above.`
      : `You're starting from the **${templateName}** template — read \`server/index.ts\` and \`client/index.tsx\` to see what's already there, then edit them in place to match the description.`

  return `# Build instructions

The user ran \`pond new\` with this description:

> ${prompt.replace(/\n/g, "\n> ")}

${starter}

Your job: implement the description. Add tables, queries, mutations, and UI to satisfy what the user asked for. When you're done, run \`npm install && npm run dev\` and verify the app works in a browser.

### Canonical references

If you need more detail than the contract below, fetch:

- https://pond.run/llms-full.txt — full server + client API in one file
- https://pond.run/docs/api-reference.md — server (\`pond/server\`)
- https://pond.run/docs/client-reference.md — client (\`pond/client\`)

${CAPSULE_CONTRACT}

### When you're done

Delete this file (\`AGENTS.md\`) and the \`.claude/\` / \`.cursor/\` directories — they were scaffolding for the build, not part of the app.
`
}

const CURSOR_RULES_HEADER = `---
description: Pond capsule contract — server + client API
alwaysApply: true
---

`

export interface CopyTemplateOptions {
  name: string
  templateName: string
  initGit: boolean
  prompt?: string
  // When true, write blank-canvas stubs instead of a template. Used by
  // `pond new --generate` so the agent has a clean slate to design from.
  useStub?: boolean
}

export interface CopyTemplateResult {
  // The template that was used. Null when `useStub: true`.
  template: Template | null
  dir: string
}

export async function copyTemplate(opts: CopyTemplateOptions): Promise<CopyTemplateResult>
export async function copyTemplate(
  name: string,
  templateName: string,
  initGit: boolean,
  prompt?: string,
): Promise<CopyTemplateResult>
export async function copyTemplate(
  nameOrOpts: string | CopyTemplateOptions,
  templateName?: string,
  initGit?: boolean,
  prompt?: string,
): Promise<CopyTemplateResult> {
  const o: CopyTemplateOptions =
    typeof nameOrOpts === "string"
      ? { name: nameOrOpts, templateName: templateName ?? "todo", initGit: Boolean(initGit), prompt }
      : nameOrOpts

  // Stub mode short-circuits the template lookup — we write a minimal
  // capsule + placeholder UI and let the agent design from scratch.
  const chosen: Template | null = o.useStub
    ? null
    : o.prompt && (o.templateName === "todo" || !o.templateName)
      ? pickTemplateForPrompt(o.prompt)
      : (getTemplate(o.templateName) ?? null)

  if (!o.useStub && !chosen) {
    console.error(`Unknown template: ${o.templateName}. Try one of: ${TEMPLATES.map((t) => t.name).join(", ")}`)
    process.exit(1)
  }

  const dir = path.resolve(process.cwd(), o.name)

  if (fs.existsSync(dir)) {
    console.error(`Directory ${o.name} already exists`)
    process.exit(1)
  }

  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, "server"), { recursive: true })
  fs.mkdirSync(path.join(dir, "client"), { recursive: true })
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true })

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: path.basename(dir),
        private: true,
        type: "module",
        scripts: {
          dev: "pond dev",
          start: "pond start",
          deploy: "pond deploy",
          inspect: "pond inspect",
          logs: "pond logs",
          "db:list": "pond db list",
          "db:dump": "pond db dump",
        },
        devDependencies: {
          pond: `^${POND_VERSION}`,
        },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(dir, "server", "index.ts"), chosen ? chosen.serverTs : STUB_SERVER_TS)
  fs.writeFileSync(path.join(dir, "client", "index.tsx"), chosen ? chosen.clientTsx : STUB_CLIENT_TSX)
  fs.writeFileSync(path.join(dir, "shared", ".gitkeep"), "")
  const envContents =
    BASE_ENV_TEMPLATE.replace("{{SESSION_SECRET}}", randomBytes(32).toString("hex")) + (chosen?.envExtra ?? "")
  fs.writeFileSync(path.join(dir, ".env.pond.server"), envContents, { mode: 0o600 })
  fs.writeFileSync(path.join(dir, ".gitignore"), GITIGNORE)

  // Always scaffold .cursor/rules + .claude/CLAUDE.md with the capsule contract
  // so any agent opening the folder picks up the rules. The AGENTS.md is only
  // written when a prompt was passed (i.e. the user wants a build kicked off).
  fs.mkdirSync(path.join(dir, ".cursor", "rules"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".cursor", "rules", "pond.mdc"), CURSOR_RULES_HEADER + CAPSULE_CONTRACT)
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true })

  if (o.prompt) {
    const agents = agentsMdContent(o.prompt, chosen?.name ?? "stub")
    fs.writeFileSync(path.join(dir, "AGENTS.md"), agents)
    fs.writeFileSync(path.join(dir, ".claude", "CLAUDE.md"), agents)
  } else {
    fs.writeFileSync(path.join(dir, ".claude", "CLAUDE.md"), `# Pond capsule\n\n${CAPSULE_CONTRACT}`)
  }

  if (o.initGit) {
    execSync("git init", { cwd: dir, stdio: "ignore" })
    execSync("git add -A", { cwd: dir, stdio: "ignore" })
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" })
  }

  return { template: chosen, dir }
}
