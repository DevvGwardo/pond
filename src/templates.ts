export interface Template {
  name: string
  description: string
  keywords: string[]
  serverTs: string
  clientTsx: string
  envExtra?: string
}

const TODO: Template = {
  name: "todo",
  description: "Default starter — a tiny message log. Good base for any CRUD app.",
  keywords: [
    "todo",
    "tasks",
    "list",
    "items",
    "checklist",
    "log",
    "diary",
    "notes",
    "tracker",
    "habit",
    "journal",
    "expense",
    "weight",
    "mood",
    "default",
  ],
  serverTs: `import { capsule, mutation, query, string, table } from "pond/server";

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
`,
  clientTsx: `import { useMutation, useQuery } from "pond/client";

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
`,
}

const AUTH_APP: Template = {
  name: "auth-app",
  description: "Authenticated app — Google sign-in + per-user state. Requires GOOGLE_CLIENT_ID/SECRET.",
  keywords: ["auth", "login", "signin", "google", "user", "users", "account", "profile", "private"],
  envExtra: `GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
`,
  serverTs: `import { capsule, mutation, query, string, table } from "pond/server";

export default capsule({
  schema: {
    notes: table({
      ownerId: string(),
      body: string(),
    }),
  },

  queries: {
    myNotes: query((ctx) => {
      if (ctx.auth.isGuest) return [];
      return ctx.db.notes.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").all();
    }),
  },

  mutations: {
    addNote: mutation((ctx, body: string) => {
      if (ctx.auth.isGuest) throw new Error("Sign in to add notes");
      return ctx.db.notes.insert({ ownerId: ctx.auth.userId, body });
    }),
  },
});
`,
  clientTsx: `import { SignInWithGoogle, signOut, useAuth, useMutation, useQuery } from "pond/client";

type Note = { id: string; body: string; createdAt: string };

export function App() {
  const auth = useAuth();
  const { data: notes } = useQuery<Note[]>("myNotes");
  const [addNote, { isLoading }] = useMutation<[body: string], void>("addNote");

  if (auth.isLoading) return <main class="min-h-screen bg-zinc-950 text-zinc-100 p-8">Loading...</main>;

  if (auth.isGuest) {
    return (
      <main class="min-h-screen bg-zinc-950 p-8 text-zinc-100 font-sans flex flex-col items-center justify-center gap-4">
        <h1 class="text-2xl font-bold">pond / auth-app</h1>
        <p class="text-zinc-400">Sign in to manage your notes.</p>
        <SignInWithGoogle class="bg-zinc-100 text-zinc-950 px-5 py-3 rounded-lg text-sm font-semibold" />
      </main>
    );
  }

  return (
    <main class="min-h-screen bg-zinc-950 p-8 text-zinc-100 font-sans max-w-2xl mx-auto">
      <header class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-bold">Welcome, {auth.displayName ?? auth.email}</h1>
        <button onClick={() => signOut()} class="text-sm text-zinc-400 underline">Sign out</button>
      </header>

      <form
        class="flex gap-2 mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("body") as HTMLInputElement;
          if (input.value.trim()) {
            void addNote(input.value.trim());
            input.value = "";
          }
        }}
      >
        <input name="body" class="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm" placeholder="New note..." />
        <button disabled={isLoading} class="bg-zinc-100 text-zinc-950 px-5 py-3 rounded-lg text-sm font-semibold">Add</button>
      </form>

      <ul class="space-y-2">
        {notes?.map((n) => (
          <li key={n.id} class="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm">{n.body}</li>
        ))}
      </ul>
    </main>
  );
}
`,
}

const BLOG: Template = {
  name: "blog",
  description: "Markdown-style posts with title + body. Public read, owner-only write.",
  keywords: ["blog", "post", "posts", "article", "writing", "markdown", "cms"],
  serverTs: `import { capsule, mutation, query, string, table } from "pond/server";

export default capsule({
  schema: {
    posts: table({
      title: string(),
      body: string(),
      authorId: string(),
    }),
  },

  queries: {
    posts: query((ctx) => ctx.db.posts.orderBy("createdAt", "desc").all()),
  },

  mutations: {
    publish: mutation((ctx, title: string, body: string) => {
      if (ctx.auth.isGuest) throw new Error("Sign in to publish");
      return ctx.db.posts.insert({ title, body, authorId: ctx.auth.userId });
    }),
    deletePost: mutation((ctx, id: string) => {
      const row = ctx.db.posts.get(id);
      if (!row) return;
      if (row.authorId !== ctx.auth.userId) throw new Error("Not your post");
      ctx.db.posts.delete(id);
    }),
  },
});
`,
  clientTsx: `import { SignInWithGoogle, useAuth, useMutation, useQuery } from "pond/client";

type Post = { id: string; title: string; body: string; authorId: string; createdAt: string };

export function App() {
  const auth = useAuth();
  const { data: posts } = useQuery<Post[]>("posts");
  const [publish, { isLoading }] = useMutation<[string, string], void>("publish");
  const [deletePost] = useMutation<[string], void>("deletePost");

  return (
    <main class="min-h-screen bg-zinc-950 p-8 text-zinc-100 font-sans max-w-3xl mx-auto">
      <header class="flex items-center justify-between mb-8">
        <h1 class="text-2xl font-bold">pond / blog</h1>
        {auth.isGuest ? (
          <SignInWithGoogle class="bg-zinc-100 text-zinc-950 px-3 py-2 rounded-md text-xs font-semibold" />
        ) : (
          <span class="text-xs text-zinc-400">Signed in as {auth.displayName ?? auth.email}</span>
        )}
      </header>

      {!auth.isGuest ? (
        <form
          class="mb-10 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget as HTMLFormElement;
            const title = (form.elements.namedItem("title") as HTMLInputElement).value.trim();
            const body = (form.elements.namedItem("body") as HTMLTextAreaElement).value.trim();
            if (title && body) {
              void publish(title, body);
              form.reset();
            }
          }}
        >
          <input name="title" class="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm" placeholder="Title" />
          <textarea name="body" rows={5} class="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm" placeholder="Body" />
          <button disabled={isLoading} class="bg-zinc-100 text-zinc-950 px-5 py-3 rounded-lg text-sm font-semibold">Publish</button>
        </form>
      ) : null}

      <ul class="space-y-6">
        {posts?.map((p) => (
          <li key={p.id} class="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
            <h2 class="text-lg font-semibold mb-1">{p.title}</h2>
            <p class="text-xs text-zinc-500 mb-3">{new Date(p.createdAt).toLocaleString()}</p>
            <p class="text-sm whitespace-pre-wrap">{p.body}</p>
            {p.authorId === auth.userId ? (
              <button onClick={() => deletePost(p.id)} class="text-xs text-red-400 underline mt-3">Delete</button>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
`,
}

const CHAT: Template = {
  name: "chat",
  description: "Group chat — polled by default; swap to a socket() handler for live updates.",
  keywords: ["chat", "messaging", "room", "talk", "im", "channel", "conversation"],
  serverTs: `import { capsule, mutation, query, string, table } from "pond/server";

export default capsule({
  schema: {
    messages: table({
      authorId: string(),
      authorName: string(),
      body: string(),
    }),
  },

  queries: {
    recent: query((ctx) => ctx.db.messages.orderBy("createdAt", "asc").limit(200).all()),
  },

  mutations: {
    send: mutation((ctx, body: string) => {
      const id = ctx.auth.isGuest ? "guest" : ctx.auth.userId;
      const name = ctx.auth.displayName ?? ctx.auth.email ?? "Anonymous";
      return ctx.db.messages.insert({ authorId: id, authorName: name, body });
    }),
  },
});
`,
  clientTsx: `import { useEffect, useState } from "preact/hooks";
import { useMutation, useQuery } from "pond/client";

type Message = { id: string; authorId: string; authorName: string; body: string; createdAt: string };

export function App() {
  const { data, refetch } = useQuery<Message[]>("recent");
  const [send] = useMutation<[string], void>("send");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const t = setInterval(() => void refetch(), 2000);
    return () => clearInterval(t);
  }, []);

  return (
    <main class="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex flex-col">
      <header class="border-b border-zinc-800 p-4">
        <h1 class="font-bold">pond / chat</h1>
      </header>
      <ul class="flex-1 overflow-y-auto p-4 space-y-2">
        {data?.map((m) => (
          <li key={m.id} class="text-sm">
            <span class="text-zinc-500 mr-2">{m.authorName}:</span>
            <span>{m.body}</span>
          </li>
        ))}
      </ul>
      <form
        class="flex gap-2 p-4 border-t border-zinc-800"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) {
            void send(draft.trim());
            setDraft("");
          }
        }}
      >
        <input
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          class="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm"
          placeholder="Say something..."
        />
        <button class="bg-zinc-100 text-zinc-950 px-4 py-2 rounded-lg text-sm font-semibold">Send</button>
      </form>
    </main>
  );
}
`,
}

const DASHBOARD: Template = {
  name: "dashboard",
  description: "KPI dashboard skeleton — server-side counter, polled cards. Drop your metrics in.",
  keywords: ["dashboard", "metrics", "stats", "analytics", "kpi", "admin", "monitoring"],
  serverTs: `import { capsule, mutation, query, number, string, table } from "pond/server";

export default capsule({
  schema: {
    events: table({
      kind: string(),
      value: number(),
    }),
  },

  queries: {
    summary: query((ctx) => {
      const all = ctx.db.events.all() as Array<{ kind: string; value: number; createdAt: string }>;
      const byKind: Record<string, { count: number; total: number }> = {};
      for (const row of all) {
        const bucket = byKind[row.kind] ?? { count: 0, total: 0 };
        bucket.count += 1;
        bucket.total += row.value;
        byKind[row.kind] = bucket;
      }
      return {
        total: all.length,
        byKind,
        recent: all.slice(-20).reverse(),
      };
    }),
  },

  mutations: {
    record: mutation((ctx, kind: string, value: number) => ctx.db.events.insert({ kind, value })),
  },
});
`,
  clientTsx: `import { useMutation, useQuery } from "pond/client";

type Summary = {
  total: number;
  byKind: Record<string, { count: number; total: number }>;
  recent: Array<{ id: string; kind: string; value: number; createdAt: string }>;
};

export function App() {
  const { data } = useQuery<Summary>("summary");
  const [record] = useMutation<[string, number], void>("record");

  return (
    <main class="min-h-screen bg-zinc-950 text-zinc-100 font-sans p-8">
      <header class="flex items-center justify-between mb-8">
        <h1 class="text-2xl font-bold">pond / dashboard</h1>
        <div class="flex gap-2">
          <button onClick={() => record("signup", 1)} class="bg-zinc-100 text-zinc-950 px-3 py-2 rounded text-xs font-semibold">+ signup</button>
          <button onClick={() => record("revenue", 19)} class="bg-zinc-100 text-zinc-950 px-3 py-2 rounded text-xs font-semibold">+ $19</button>
        </div>
      </header>

      <section class="grid grid-cols-3 gap-4 mb-8">
        <Card label="Total events" value={data?.total ?? 0} />
        {Object.entries(data?.byKind ?? {}).map(([kind, agg]) => (
          <Card key={kind} label={kind} value={agg.count} sub={\`sum: \${agg.total}\`} />
        ))}
      </section>

      <section>
        <h2 class="text-sm uppercase text-zinc-500 mb-3">Recent</h2>
        <ul class="space-y-1 text-sm">
          {data?.recent.map((r) => (
            <li key={r.id} class="flex justify-between bg-zinc-900 border border-zinc-800 rounded px-3 py-2">
              <span>{r.kind}</span>
              <span class="text-zinc-500">{r.value}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Card({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div class="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <div class="text-xs uppercase text-zinc-500 mb-2">{label}</div>
      <div class="text-3xl font-bold">{value}</div>
      {sub ? <div class="text-xs text-zinc-500 mt-1">{sub}</div> : null}
    </div>
  );
}
`,
}

const WEBHOOK_HANDLER: Template = {
  name: "webhook-handler",
  description: "Receive + persist + view webhook deliveries. Endpoint at POST /api/hook.",
  keywords: ["webhook", "hook", "receive", "callback", "incoming", "integration", "stripe", "github"],
  serverTs: `import { capsule, endpoint, json, query, string, table } from "pond/server";

export default capsule({
  schema: {
    deliveries: table({
      source: string(),
      body: string(),
    }),
  },

  queries: {
    deliveries: query((ctx) => ctx.db.deliveries.orderBy("createdAt", "desc").limit(100).all()),
  },

  mutations: {},

  endpoints: {
    hook: endpoint({ method: "POST", path: "/api/hook" }, async (ctx, req) => {
      const body = await req.text();
      const source = req.headers.get("x-source") ?? "unknown";
      ctx.db.deliveries.insert({ source, body });
      return json({ ok: true });
    }),
  },
});
`,
  clientTsx: `import { useQuery } from "pond/client";

type Delivery = { id: string; source: string; body: string; createdAt: string };

export function App() {
  const { data: deliveries } = useQuery<Delivery[]>("deliveries");

  return (
    <main class="min-h-screen bg-zinc-950 text-zinc-100 font-sans p-8">
      <header class="mb-6">
        <h1 class="text-2xl font-bold mb-1">pond / webhook-handler</h1>
        <p class="text-sm text-zinc-400">POST to <code class="bg-zinc-900 px-1 rounded">/api/hook</code> — recent deliveries listed below.</p>
      </header>
      <ul class="space-y-3">
        {deliveries?.map((d) => (
          <li key={d.id} class="bg-zinc-900 border border-zinc-800 rounded p-4 text-sm">
            <div class="flex justify-between mb-2 text-xs text-zinc-500">
              <span>{d.source}</span>
              <span>{new Date(d.createdAt).toLocaleString()}</span>
            </div>
            <pre class="whitespace-pre-wrap break-all text-xs">{d.body}</pre>
          </li>
        ))}
      </ul>
    </main>
  );
}
`,
}

export const TEMPLATES: Template[] = [TODO, AUTH_APP, BLOG, CHAT, DASHBOARD, WEBHOOK_HANDLER]

export function getTemplate(name: string): Template | null {
  return TEMPLATES.find((t) => t.name === name) ?? null
}

// Minimal "blank canvas" scaffold for `pond new --generate`. The agent reads
// AGENTS.md and rewrites both files from scratch — we don't want a working
// template colouring its output. Not part of TEMPLATES; not selectable via
// --template; only used internally when generate mode is active.
export const STUB_SERVER_TS = `import { capsule } from "pond/server";

// Stub. The agent should design schema, queries, and mutations from the
// prompt in AGENTS.md, then replace this whole file.
export default capsule({
  schema: {},
  queries: {},
  mutations: {},
});
`

export const STUB_CLIENT_TSX = `// Stub. The agent should design the UI to match the prompt in AGENTS.md,
// then replace this whole file.

export function App() {
  return (
    <main class="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex items-center justify-center">
      <div class="text-center">
        <h1 class="text-2xl font-bold mb-2">Building…</h1>
        <p class="text-sm text-zinc-500">The agent hasn't replaced this stub yet.</p>
      </div>
    </main>
  );
}
`

export function pickTemplateForPrompt(prompt: string): Template {
  const text = prompt.toLowerCase()
  const scores = TEMPLATES.map((t) => {
    let score = 0
    for (const kw of t.keywords) {
      if (text.includes(kw)) score += kw.length
    }
    return { t, score }
  })
  scores.sort((a, b) => b.score - a.score)
  return scores[0].score > 0 ? scores[0].t : TODO
}
