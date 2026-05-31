export interface Template {
  name: string
  description: string
  keywords: string[]
  serverTs: string
  clientTsx: string
  envExtra?: string
}

// Shared house style for every template:
//   - bg-black background (not zinc-950)
//   - neutral-* palette (truer grays)
//   - square corners — no rounded-* except round avatars
//   - wireframe buttons (border-white outline) for primary actions
//   - display headings (text-5xl tracking-tight) — confident, not timid
//   - mono small text for metadata (timestamps, indices, source tags)
//   - max-w-2xl centered column unless the template's signature breaks it
//
// Each template adds one signature move so they don't blur into the same
// silhouette: todo uses numbered newspaper rows, blog goes serif for the
// post body, chat is full-bleed bottom-anchored terminal-style, dashboard
// uses oversized tabular-nums numbers, webhook is pure mono log lines.

const TODO: Template = {
  name: "todo",
  description: "Default starter — single-column todo list with numbered newspaper rows.",
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
    <main class="min-h-screen bg-black px-6 py-14 text-white">
      <section class="mx-auto max-w-2xl">
        <p class="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">pond / todo</p>
        <h1 class="mb-10 text-5xl font-bold tracking-tight">Things to do.</h1>

        <form
          class="mb-10 flex gap-3"
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
            class="min-w-0 flex-1 border border-neutral-700 bg-black px-3 py-2 text-white outline-none focus:border-white"
            placeholder="What needs doing?"
          />
          <button
            type="submit"
            disabled={isSending}
            class="border border-white px-4 py-2 font-medium disabled:opacity-40"
          >
            {isSending ? "Adding…" : "Add"}
          </button>
        </form>

        {isLoading ? <p class="font-mono text-xs text-neutral-500">loading…</p> : null}

        <ul class="divide-y divide-neutral-900 border-y border-neutral-900">
          {messages?.map((m, i) => (
            <li key={m.id} class="flex items-baseline gap-4 py-3">
              <span class="font-mono text-xs text-neutral-600 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              <span class="flex-1">{m.body}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
`,
}

const AUTH_APP: Template = {
  name: "auth-app",
  description: "Authenticated app — Google sign-in + per-user notes. Requires GOOGLE_CLIENT_ID/SECRET.",
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

function ts(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function App() {
  const auth = useAuth();
  const { data: notes } = useQuery<Note[]>("myNotes");
  const [addNote, { isLoading }] = useMutation<[body: string], void>("addNote");

  if (auth.isLoading) {
    return (
      <main class="min-h-screen bg-black px-6 py-14 text-white">
        <p class="mx-auto max-w-2xl font-mono text-xs text-neutral-500">checking session…</p>
      </main>
    );
  }

  if (auth.isGuest) {
    return (
      <main class="flex min-h-screen flex-col items-start justify-center bg-black px-6 py-14 text-white">
        <section class="mx-auto w-full max-w-2xl">
          <p class="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">pond / notes</p>
          <h1 class="mb-4 text-6xl font-bold tracking-tighter">Your notes.<br/>Only yours.</h1>
          <p class="mb-10 max-w-md text-lg text-neutral-400">Private to your Google account. Sign in to write something down.</p>
          <SignInWithGoogle class="inline-block border border-white px-5 py-3 font-medium hover:bg-white hover:text-black" />
        </section>
      </main>
    );
  }

  return (
    <main class="min-h-screen bg-black px-6 py-10 text-white">
      <section class="mx-auto max-w-2xl">
        <header class="mb-10 flex items-baseline justify-between gap-3">
          <h1 class="text-3xl font-bold tracking-tight">{auth.displayName ?? auth.email}</h1>
          <button onClick={() => signOut()} class="font-mono text-xs text-neutral-500 hover:text-white">sign out</button>
        </header>

        <form
          class="mb-10"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem("body") as HTMLInputElement;
            if (input.value.trim()) {
              void addNote(input.value.trim());
              input.value = "";
            }
          }}
        >
          <input
            name="body"
            class="w-full border-b border-neutral-700 bg-transparent py-3 text-lg outline-none placeholder:text-neutral-600 focus:border-white"
            placeholder="What's on your mind?"
            disabled={isLoading}
          />
        </form>

        <ul class="space-y-6">
          {notes?.map((n) => (
            <li key={n.id} class="border-l-2 border-neutral-800 pl-4">
              <p class="mb-1 font-mono text-xs text-neutral-500 tabular-nums">{ts(n.createdAt)}</p>
              <p class="leading-relaxed">{n.body}</p>
            </li>
          ))}
        </ul>

        {notes && notes.length === 0 ? (
          <p class="font-mono text-xs text-neutral-600">no notes yet.</p>
        ) : null}
      </section>
    </main>
  );
}
`,
}

const BLOG: Template = {
  name: "blog",
  description: "Editorial blog — serif body type, mono bylines, no card chrome.",
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

function dateline(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }).toUpperCase();
}

export function App() {
  const auth = useAuth();
  const { data: posts } = useQuery<Post[]>("posts");
  const [publish, { isLoading }] = useMutation<[string, string], void>("publish");
  const [deletePost] = useMutation<[string], void>("deletePost");

  return (
    <main class="min-h-screen bg-black px-6 py-14 text-white">
      <section class="mx-auto max-w-2xl">
        <header class="mb-16 flex items-baseline justify-between border-b border-neutral-800 pb-6">
          <div>
            <p class="font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">pond / journal</p>
            <h1 class="mt-2 text-4xl font-bold tracking-tight">Field notes.</h1>
          </div>
          {auth.isGuest ? (
            <SignInWithGoogle class="border border-white px-3 py-1.5 text-sm font-medium" />
          ) : (
            <span class="font-mono text-xs text-neutral-500">{auth.displayName ?? auth.email}</span>
          )}
        </header>

        {!auth.isGuest ? (
          <form
            class="mb-16 space-y-4 border border-neutral-800 p-5"
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
            <input
              name="title"
              class="w-full bg-transparent text-2xl font-bold tracking-tight outline-none placeholder:text-neutral-700"
              placeholder="Title"
            />
            <textarea
              name="body"
              rows={6}
              class="w-full resize-none bg-transparent font-serif text-base leading-relaxed outline-none placeholder:text-neutral-700"
              placeholder="Start writing…"
            />
            <button
              disabled={isLoading}
              class="border border-white px-4 py-2 text-sm font-medium hover:bg-white hover:text-black disabled:opacity-40"
            >
              Publish
            </button>
          </form>
        ) : null}

        <ul class="space-y-16">
          {posts?.map((p) => (
            <li key={p.id}>
              <p class="mb-2 font-mono text-xs tracking-widest text-neutral-500">{dateline(p.createdAt)}</p>
              <h2 class="mb-3 text-3xl font-bold tracking-tight">{p.title}</h2>
              <p class="whitespace-pre-wrap font-serif text-base leading-relaxed text-neutral-200">{p.body}</p>
              {p.authorId === auth.userId ? (
                <button
                  onClick={() => deletePost(p.id)}
                  class="mt-4 font-mono text-xs text-neutral-600 hover:text-red-400"
                >
                  delete post
                </button>
              ) : null}
            </li>
          ))}
        </ul>

        {posts && posts.length === 0 ? (
          <p class="font-mono text-xs text-neutral-600">nothing published yet.</p>
        ) : null}
      </section>
    </main>
  );
}
`,
}

const CHAT: Template = {
  name: "chat",
  description: "Terminal-style chat — bottom-anchored composer, mono messages, color-coded senders.",
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
  clientTsx: `import { useEffect, useRef, useState } from "preact/hooks";
import { useMutation, useQuery } from "pond/client";

type Message = { id: string; authorId: string; authorName: string; body: string; createdAt: string };

// Stable per-author tint so the eye can scan a busy room without reading
// every name. Five hand-picked hues; not "random colors", not "every
// message looks the same".
const PALETTE = ["text-amber-300", "text-emerald-300", "text-sky-300", "text-rose-300", "text-violet-300"];
function hueFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function App() {
  const { data, refetch } = useQuery<Message[]>("recent");
  const [send] = useMutation<[string], void>("send");
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const t = setInterval(() => void refetch(), 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [data?.length]);

  return (
    <main class="flex h-screen flex-col bg-black text-white">
      <header class="flex items-baseline justify-between border-b border-neutral-900 px-6 py-4">
        <p class="font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">pond / room</p>
        <p class="font-mono text-xs text-neutral-600 tabular-nums">{data?.length ?? 0} msgs</p>
      </header>

      <ul ref={scrollRef} class="flex-1 overflow-y-auto px-6 py-4 font-mono text-sm">
        {data?.map((m) => (
          <li key={m.id} class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 py-1">
            <span class={\`shrink-0 \${hueFor(m.authorId)}\`}>{m.authorName}</span>
            <span class="min-w-0 whitespace-pre-wrap break-words text-neutral-200">{m.body}</span>
            <span class="shrink-0 text-xs text-neutral-700 tabular-nums">{clockTime(m.createdAt)}</span>
          </li>
        ))}
      </ul>

      <form
        class="flex items-center gap-3 border-t border-neutral-900 px-6 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) {
            void send(draft.trim());
            setDraft("");
          }
        }}
      >
        <span class="font-mono text-sm text-neutral-600">&gt;</span>
        <input
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          class="min-w-0 flex-1 bg-transparent font-mono text-sm text-white outline-none placeholder:text-neutral-700"
          placeholder="type and press enter…"
          autoFocus
        />
        <kbd class="border border-neutral-800 px-2 py-0.5 font-mono text-[10px] text-neutral-500">↵</kbd>
      </form>
    </main>
  );
}
`,
}

const DASHBOARD: Template = {
  name: "dashboard",
  description: "KPI dashboard — oversized tabular numbers, no card chrome.",
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

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\\.0$/, "") + "k";
  return String(n);
}

function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div class="border-t border-neutral-800 pt-4">
      <p class="font-mono text-[11px] uppercase tracking-[0.2em] text-neutral-500">{label}</p>
      <p class="mt-2 text-6xl font-bold tracking-tighter tabular-nums">{value}</p>
      {sub ? <p class="mt-1 font-mono text-xs text-neutral-500 tabular-nums">{sub}</p> : null}
    </div>
  );
}

export function App() {
  const { data } = useQuery<Summary>("summary");
  const [record] = useMutation<[string, number], void>("record");
  const kinds = Object.entries(data?.byKind ?? {});

  return (
    <main class="min-h-screen bg-black px-6 py-12 text-white">
      <section class="mx-auto max-w-4xl">
        <header class="mb-14 flex items-end justify-between">
          <div>
            <p class="font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">pond / dashboard</p>
            <h1 class="mt-2 text-4xl font-bold tracking-tight">Today.</h1>
          </div>
          <div class="flex gap-2 font-mono text-xs">
            <button onClick={() => record("signup", 1)} class="border border-neutral-800 px-3 py-1.5 hover:border-white">+ signup</button>
            <button onClick={() => record("revenue", 19)} class="border border-neutral-800 px-3 py-1.5 hover:border-white">+ $19</button>
          </div>
        </header>

        <section class="mb-16 grid grid-cols-2 gap-x-10 gap-y-8 md:grid-cols-3">
          <Stat label="events total" value={compact(data?.total ?? 0)} />
          {kinds.map(([kind, agg]) => (
            <Stat key={kind} label={kind} value={compact(agg.count)} sub={\`sum \${compact(agg.total)}\`} />
          ))}
        </section>

        <section>
          <p class="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-neutral-500">stream</p>
          <ul class="divide-y divide-neutral-900 border-y border-neutral-900 font-mono text-sm">
            {data?.recent.map((r) => (
              <li key={r.id} class="flex items-baseline justify-between gap-4 py-2 tabular-nums">
                <span class="text-neutral-600">{clockTime(r.createdAt)}</span>
                <span class="flex-1 text-neutral-300">{r.kind}</span>
                <span>{r.value}</span>
              </li>
            ))}
          </ul>
        </section>
      </section>
    </main>
  );
}
`,
}

const WEBHOOK_HANDLER: Template = {
  name: "webhook-handler",
  description: "Webhook receiver + log — pure mono terminal aesthetic, no cards.",
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

function logTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())} \${pad(d.getHours())}:\${pad(d.getMinutes())}:\${pad(d.getSeconds())}\`;
}

export function App() {
  const { data: deliveries } = useQuery<Delivery[]>("deliveries");

  return (
    <main class="min-h-screen bg-black px-6 py-12 font-mono text-sm text-white">
      <section class="mx-auto max-w-3xl">
        <header class="mb-10">
          <p class="text-xs uppercase tracking-[0.2em] text-neutral-500">pond / hook</p>
          <h1 class="mt-2 font-sans text-4xl font-bold tracking-tight">Inbound.</h1>
          <p class="mt-3 text-xs text-neutral-500">
            POST <span class="text-emerald-400">/api/hook</span> with header <span class="text-neutral-300">x-source: &lt;name&gt;</span>.
            Latest 100 deliveries are kept.
          </p>
        </header>

        {deliveries && deliveries.length === 0 ? (
          <p class="text-xs text-neutral-600">no deliveries yet. fire one with:</p>
        ) : null}
        {deliveries && deliveries.length === 0 ? (
          <pre class="mt-3 whitespace-pre-wrap text-xs text-neutral-500">
{\`curl -X POST http://localhost:3000/api/hook \\\\
  -H "x-source: test" \\\\
  -d '{"hello":"world"}'\`}
          </pre>
        ) : null}

        <ul class="space-y-6">
          {deliveries?.map((d) => (
            <li key={d.id}>
              <div class="flex items-baseline gap-3 text-xs">
                <span class="text-neutral-600 tabular-nums">{logTime(d.createdAt)}</span>
                <span class="text-emerald-400">{d.source}</span>
              </div>
              <pre class="mt-1 whitespace-pre-wrap break-all border-l-2 border-neutral-800 pl-3 text-xs text-neutral-300">{d.body}</pre>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
`,
}

const SHOPIFY: Template = {
  name: "shopify",
  description: "Shopify-connected capsule — query your store\'s Admin API with a Custom App token.",
  keywords: ["shopify", "store", "products", "ecommerce", "commerce", "orders", "inventory"],
  envExtra: `SHOPIFY_SHOP=
SHOPIFY_TOKEN=
# SHOPIFY_API_VERSION=2025-01
`,
  serverTs: `import { capsule, query } from "pond/server";

// ── Shopify capsule ──────────────────────────────────────────────
// Uses ctx.shopify.graphql() to call the Shopify Admin GraphQL API.
//
// 1. In your Shopify admin: Settings → Apps and sales channels →
//    Develop apps → Create an app (or use an existing Custom App).
// 2. Under "Admin API integration", copy the Admin API access token.
// 3. Set your env vars:
//      pond env set <deployId> SHOPIFY_SHOP=my-store.myshopify.com
//      pond env set <deployId> SHOPIFY_TOKEN=shpat_abc123
//    Or for local dev, add them to .env.pond.server in this directory.
// 4. Optionally override the API version:
//      SHOPIFY_API_VERSION=2025-04
//    (defaults to 2025-01)

export default capsule({
  schema: {},

  queries: {
    products: query(async (ctx) => {
      const result = await ctx.shopify.graphql<{
        products: { edges: Array<{ node: { id: string; title: string; status: string; totalInventory: number } }> };
      }>(\`{
        products(first: 20) {
          edges {
            node {
              id
              title
              status
              totalInventory
            }
          }
        }
      }\`);
      return result.products.edges.map((e) => e.node);
    }),
  },

  mutations: {},
});
`,
  clientTsx: `import { useQuery } from "pond/client";

type Product = {
  id: string;
  title: string;
  status: string;
  totalInventory: number;
};

export function App() {
  const { data: products, isLoading, error } = useQuery<Product[]>("products");

  return (
    <main class="min-h-screen bg-black px-6 py-14 text-white">
      <section class="mx-auto max-w-4xl">
        <p class="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">pond / shopify</p>
        <h1 class="mb-2 text-5xl font-bold tracking-tight">Products.</h1>
        <p class="mb-10 text-sm text-neutral-500">Loaded from your Shopify store via Admin API.</p>

        {isLoading ? <p class="font-mono text-xs text-neutral-500">loading products\u2026</p> : null}

        {error ? (
          <div class="border border-red-900 bg-red-950/30 px-4 py-3 font-mono text-xs text-red-400">
            <p class="mb-1 font-semibold uppercase tracking-widest">Error</p>
            <p class="break-all">{error instanceof Error ? error.message : String(error)}</p>
            <p class="mt-2 text-neutral-500">
              Set SHOPIFY_SHOP and SHOPIFY_TOKEN in .env.pond.server, or run
              {\` pond env set <deployId> SHOPIFY_SHOP=... SHOPIFY_TOKEN=...\`} for a hosted deploy.
            </p>
          </div>
        ) : null}

        {products && products.length === 0 ? (
          <p class="font-mono text-xs text-neutral-600">No products found, or the store is empty.</p>
        ) : null}

        {products && products.length > 0 ? (
          <table class="w-full border-collapse font-mono text-sm">
            <thead>
              <tr class="border-b border-neutral-800 text-left text-xs uppercase tracking-widest text-neutral-500">
                <th class="pb-2 font-normal">Title</th>
                <th class="pb-2 font-normal">Status</th>
                <th class="pb-2 text-right font-normal tabular-nums">Inventory</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-900">
              {products.map((p) => (
                <tr key={p.id} class="hover:bg-neutral-950">
                  <td class="py-3 pr-4">{p.title}</td>
                  <td class="py-3 pr-4">
                    <span
                      class={"inline-block border px-2 py-0.5 text-[10px] uppercase tracking-widest " +
                        (p.status === "ACTIVE" ? "border-emerald-800 text-emerald-400" : "border-neutral-700 text-neutral-500")}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td class="py-3 text-right tabular-nums text-neutral-300">{p.totalInventory}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <p class="mt-10 border-t border-neutral-900 pt-6 font-mono text-[10px] leading-relaxed text-neutral-600">
          Powered by the Shopify Admin API. Create a Custom App in your Shopify admin to get an access token.
        </p>
      </section>
    </main>
  );
}
`,
}

export const TEMPLATES: Template[] = [TODO, AUTH_APP, BLOG, CHAT, DASHBOARD, WEBHOOK_HANDLER, SHOPIFY]

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
// then replace this whole file. Design intentionally — pick a palette,
// commit to a type scale, vary weight + spacing for hierarchy. Avoid the
// generic "zinc-950 + rounded card stack + white pill button" default.

export function App() {
  return (
    <main class="min-h-screen bg-black px-6 py-14 text-white">
      <section class="mx-auto max-w-2xl">
        <p class="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">pond</p>
        <h1 class="mb-3 text-5xl font-bold tracking-tight">Building…</h1>
        <p class="text-neutral-400">The agent hasn't replaced this stub yet.</p>
      </section>
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
