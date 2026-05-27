import * as esbuild from "esbuild"
import * as path from "node:path"
import { createRequire } from "node:module"

// Resolve preact via Node's module resolution so we work regardless of npm's
// hoisting choice. The old code aliased to `../node_modules/preact/...`
// relative to this file, which only resolved when preact was nested under
// pondsh/node_modules — modern npm hoists peer copies up to the consumer's
// root node_modules, leaving that path nonexistent.
const moduleRequire = createRequire(import.meta.url)
const preactDir = path.dirname(moduleRequire.resolve("preact/package.json"))

export async function buildClient(entry: string, options: { liveReload?: boolean } = {}): Promise<string> {
  // IIFE format with a globalName wraps the user bundle so its identifiers
  // (preact's `h`, `render`, hooks, the user's `App`) do not leak into the
  // surrounding HTML shell's module scope. The previous setup imported `h`
  // from esm.sh in the shell AND inlined another `h` from the bundled
  // preact in `${js}` — that's a top-level "Identifier 'h' has already been
  // declared" at parse time. Bundling as IIFE puts everything in a closure
  // and exposes only the named exports of the user's entry on
  // `globalThis.__pondApp`. We then mount the App with the SAME preact
  // instance that the user's hooks use (avoiding the "two preacts" bug
  // where hooks silently fail).
  //
  // Synthesise the entry so __pondApp always has {App, render, h}: the
  // user's client/index.tsx only exports App, and re-exporting preact's
  // render/h from every capsule's entry would be repetitive boilerplate.
  const entryDir = path.dirname(entry)
  const entryRel = "./" + path.relative(entryDir, entry).replace(/\\/g, "/")
  const stdinContents = `
import { App } from ${JSON.stringify(entryRel)};
export { App };
export { render, h } from "preact";
`
  const result = await esbuild.build({
    stdin: {
      contents: stdinContents,
      resolveDir: entryDir,
      sourcefile: "pond-client-entry.tsx",
      loader: "tsx",
    },
    bundle: true,
    minify: false,
    write: false,
    format: "iife",
    globalName: "__pondApp",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "preact",
    alias: {
      "pond/client": path.resolve(import.meta.dirname, "../client/index.ts"),
      "preact/jsx-runtime": path.join(preactDir, "jsx-runtime/dist/jsxRuntime.module.js"),
      "preact/jsx-dev-runtime": path.join(preactDir, "jsx-runtime/dist/jsxRuntime.module.js"),
      "preact/hooks": path.join(preactDir, "hooks/dist/hooks.module.js"),
      preact: path.join(preactDir, "dist/preact.module.js"),
    },
    define: {
      "process.env.NODE_ENV": '"development"',
    },
  })

  const js = result.outputFiles[0].text

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>pond</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
            mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
          }
        }
      }
    }
  </script>
  <style>
    /* Pond base: design tokens + opt-in component classes. Agents are told
       in CLAUDE.md to prefer .btn / .card / .input / .label / .kbd for
       instant polish, and to override with Tailwind utilities when needed. */
    :root {
      --bg: #09090b;
      --bg-elev: #18181b;
      --bg-soft: rgba(255, 255, 255, 0.04);
      --fg: #fafafa;
      --fg-muted: #a1a1aa;
      --fg-subtle: #52525b;
      --border: #27272a;
      --accent: #fafafa;
      --accent-fg: #09090b;
      --danger: #f87171;
      --success: #34d399;
      --radius-sm: 6px;
      --radius: 10px;
      --radius-lg: 16px;
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    h1, h2, h3, h4 { font-weight: 600; letter-spacing: -0.01em; line-height: 1.2; margin: 0; }
    h1 { font-size: 1.875rem; letter-spacing: -0.02em; }
    h2 { font-size: 1.5rem; }
    h3 { font-size: 1.125rem; }
    p { margin: 0; }
    a { color: inherit; }
    code, kbd, samp { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.875em; }

    .card {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem;
    }

    .input, .textarea, .select {
      width: 100%;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0.5rem 0.75rem;
      font: inherit;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .input::placeholder, .textarea::placeholder { color: var(--fg-subtle); }
    .input:focus, .textarea:focus, .select:focus {
      border-color: var(--fg-muted);
      box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.06);
    }

    .label {
      display: block;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--fg-muted);
      margin-bottom: 0.375rem;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.375rem;
      height: 2.25rem;
      padding: 0 0.875rem;
      border-radius: var(--radius-sm);
      font: inherit;
      font-weight: 500;
      font-size: 0.875rem;
      cursor: pointer;
      border: 1px solid transparent;
      background: transparent;
      color: var(--fg);
      transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
      user-select: none;
    }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: var(--accent-fg); }
    .btn-primary:not(:disabled):hover { background: #ffffff; }
    .btn-secondary { background: var(--bg-elev); border-color: var(--border); }
    .btn-secondary:not(:disabled):hover { background: #27272a; }
    .btn-ghost { background: transparent; color: var(--fg-muted); }
    .btn-ghost:not(:disabled):hover { background: var(--bg-soft); color: var(--fg); }
    .btn-danger { background: transparent; color: var(--danger); border-color: var(--border); }
    .btn-danger:not(:disabled):hover { background: rgba(248, 113, 113, 0.1); }

    .kbd {
      display: inline-flex;
      align-items: center;
      height: 1.25rem;
      padding: 0 0.375rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.6875rem;
      color: var(--fg-muted);
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-bottom-width: 2px;
      border-radius: 4px;
    }

    .divider { height: 1px; background: var(--border); border: 0; margin: 1rem 0; }

    ::selection { background: rgba(255, 255, 255, 0.15); color: var(--fg); }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }
    ::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
  </style>
</head>
<body>
  <div id="root"></div>
  ${
    options.liveReload
      ? `<script>
    const es = new EventSource('/__pond_reload')
    es.onmessage = () => location.reload()
  </script>`
      : ""
  }
  <script>
${js}
  </script>
  <script>
    (function () {
      var app = (typeof window !== "undefined" && window.__pondApp) || {};
      var App = app.App || app.default;
      var render = app.render;
      var h = app.h;
      if (!App) { console.error("[pond] client bundle missing exported App"); return; }
      if (!render || !h) { console.error("[pond] client bundle missing render/h exports from pond/client"); return; }
      render(h(App, null), document.getElementById("root"));
    })();
  </script>
</body>
</html>`
}
