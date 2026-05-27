import * as esbuild from "esbuild"
import * as path from "node:path"

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
  const result = await esbuild.build({
    entryPoints: [entry],
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
      "preact/jsx-runtime": path.resolve(
        import.meta.dirname,
        "../node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js",
      ),
      "preact/jsx-dev-runtime": path.resolve(
        import.meta.dirname,
        "../node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js",
      ),
      "preact/hooks": path.resolve(import.meta.dirname, "../node_modules/preact/hooks/dist/hooks.module.js"),
      preact: path.resolve(import.meta.dirname, "../node_modules/preact/dist/preact.module.js"),
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
    * { box-sizing: border-box; }
    body { margin: 0; background: #09090b; }
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
