import * as fs from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { randomBytes } from "node:crypto"

const TODO_SERVER_TS = `import { capsule, mutation, query, string, table } from "pond/server";

export default capsule({
  schema: {
    messages: table({
      body: string(),
    }),
  },

  queries: {
    messages: query((ctx) =>
      ctx.db.messages.orderBy("createdAt", "desc").all()
    ),
  },

  mutations: {
    sendMessage: mutation((ctx, body: string) =>
      ctx.db.messages.insert({ body })
    ),
  },
});
`

const TODO_CLIENT_TSX = `import { useMutation, useQuery } from "pond/client";

type Message = {
  id: string;
  body: string;
  createdAt: string;
};

export function App() {
  const { data: messages, isLoading } = useQuery<Message[]>("messages");
  const [sendMessage, { isLoading: isSending }] = useMutation<[body: string], void>("sendMessage");

  return (
    <main class="min-h-screen bg-zinc-950 p-8 text-zinc-100 font-sans">
      <h1 class="text-2xl font-bold mb-6">pond / todo</h1>

      <form
        class="flex gap-2 mb-8"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("body") as HTMLInputElement;
          if (input.value.trim()) {
            void sendMessage(input.value.trim());
            input.value = "";
          }
        }}
      >
        <input
          name="body"
          class="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm outline-none focus:border-zinc-600 transition-colors"
          placeholder="What needs doing?"
        />
        <button
          type="submit"
          disabled={isSending}
          class="bg-zinc-100 text-zinc-950 px-5 py-3 rounded-lg text-sm font-semibold hover:bg-zinc-200 transition-colors"
        >
          {isSending ? "Sending..." : "Send"}
        </button>
      </form>

      {isLoading ? <p class="text-sm text-zinc-500 mb-4">Loading...</p> : null}

      <ul class="space-y-2">
        {messages?.map((m) => (
          <li key={m.id} class="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm">
            {m.body}
          </li>
        ))}
      </ul>
    </main>
  );
}
`

const TODO_ENV_TEMPLATE = `# Server-only environment variables
# POND_SESSION_SECRET={{SESSION_SECRET}}
# OPENAI_API_KEY=sk-...
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
`

const TODO_GITIGNORE = `node_modules
.pond
`

const POND_VERSION = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf-8"))
  .version as string

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
      const row = ctx.db.items.where({ id }).first()
      if (row) ctx.db.items.where({ id }).update({ done: !row.done })
    }),
  },
})
\`\`\`

Every table auto-gets \`id\` (uuid), \`createdAt\`, \`updatedAt\`. Column helpers: \`string()\`, \`number()\`, \`boolean()\`, \`json()\`, \`text()\`. SQLite under the hood — booleans round-trip as 0/1.

\`ctx.db.<table>\` exposes \`.all() / .first() / .where({...}) / .orderBy(col, dir) / .insert({...}) / .update({...}) / .delete()\`.

Queries return data and re-run reactively on the client. Mutations take \`(ctx, ...args)\` — the args after \`ctx\` are the wire payload.

### client/index.tsx

Preact + Tailwind classes (use \`class\` not \`className\`). Use \`useQuery<T>(name)\` and \`useMutation<Args, Ret>(name)\` from \`"pond/client"\`.

\`\`\`tsx
import { useMutation, useQuery } from "pond/client"

export function App() {
  const { data, isLoading } = useQuery<Item[]>("items")
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
- Tailwind classes are available out of the box; no config needed.
`

function agentsMdContent(prompt: string): string {
  return `# Build instructions

The user ran \`pond new\` with this description:

> ${prompt.replace(/\n/g, "\n> ")}

Your job: implement this inside the scaffolded capsule. Edit \`server/index.ts\` and \`client/index.tsx\`. Add tables, queries, mutations, and UI to satisfy the description. When you're done, run \`npm install && npm run dev\` and verify the app works in a browser.

### Canonical references

If you need more detail than the contract below, fetch:

- https://pond.run/llms-full.txt — full server + client API in one file
- https://pond.run/docs/api-reference.md — server (\`pond/server\`)
- https://pond.run/docs/client-reference.md — client (\`pond/client\`)

${CAPSULE_CONTRACT}

### When you're done

Delete this file (\`AGENTS.md\`) and the \`.claude/\` directory — they were scaffolding for the build, not part of the app.
`
}

export async function copyTemplate(name: string, _template: string, initGit: boolean, prompt?: string): Promise<void> {
  const dir = path.resolve(process.cwd(), name)

  if (fs.existsSync(dir)) {
    console.error(`Directory ${name} already exists`)
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
  fs.writeFileSync(path.join(dir, "server", "index.ts"), TODO_SERVER_TS)
  fs.writeFileSync(path.join(dir, "client", "index.tsx"), TODO_CLIENT_TSX)
  fs.writeFileSync(path.join(dir, "shared", ".gitkeep"), "")
  const envContents = TODO_ENV_TEMPLATE.replace("{{SESSION_SECRET}}", randomBytes(32).toString("hex"))
  fs.writeFileSync(path.join(dir, ".env.pond.server"), envContents, { mode: 0o600 })
  fs.writeFileSync(path.join(dir, ".gitignore"), TODO_GITIGNORE)

  if (prompt) {
    const agents = agentsMdContent(prompt)
    fs.writeFileSync(path.join(dir, "AGENTS.md"), agents)
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".claude", "CLAUDE.md"), agents)
  }

  if (initGit) {
    execSync("git init", { cwd: dir, stdio: "ignore" })
    execSync("git add -A", { cwd: dir, stdio: "ignore" })
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" })
  }
}
