import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

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
`;

const TODO_CLIENT_TSX = `import { useMutation, useQuery } from "pond/client";

type Message = {
  id: string;
  body: string;
  createdAt: string;
};

export function App() {
  const messages = useQuery<Message[]>("messages");
  const sendMessage = useMutation<[body: string], void>("sendMessage");

  return (
    <main class="min-h-screen bg-zinc-950 p-8 text-zinc-100 font-sans">
      <h1 class="text-2xl font-bold mb-6">pond / todo</h1>

      <form
        class="flex gap-2 mb-8"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("body") as HTMLInputElement;
          if (input.value.trim()) {
            sendMessage(input.value.trim());
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
          class="bg-zinc-100 text-zinc-950 px-5 py-3 rounded-lg text-sm font-semibold hover:bg-zinc-200 transition-colors"
        >
          Send
        </button>
      </form>

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
`;

const TODO_ENV = `# Server-only environment variables
# OPENAI_API_KEY=sk-...
`;

export async function copyTemplate(
  name: string,
  _template: string,
  initGit: boolean
): Promise<void> {
  const dir = path.resolve(process.cwd(), name);

  if (fs.existsSync(dir)) {
    console.error(`Directory ${name} already exists`);
    process.exit(1);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "server"), { recursive: true });
  fs.mkdirSync(path.join(dir, "client"), { recursive: true });
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });

  fs.writeFileSync(path.join(dir, "server", "index.ts"), TODO_SERVER_TS);
  fs.writeFileSync(path.join(dir, "client", "index.tsx"), TODO_CLIENT_TSX);
  fs.writeFileSync(path.join(dir, "shared", ".gitkeep"), "");
  fs.writeFileSync(path.join(dir, ".env.pond.server"), TODO_ENV);

  if (initGit) {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git add -A", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  }
}
