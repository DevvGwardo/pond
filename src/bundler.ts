import * as esbuild from "esbuild"
import * as path from "node:path"
import { createRequire } from "node:module"
import { confineImportsTo } from "./build-confinement.js"
import { containedRealPath } from "./host/fs-safe.js"

// Resolve preact via Node's module resolution so we work regardless of npm's
// hoisting choice. The old code aliased to `../node_modules/preact/...`
// relative to this file, which only resolved when preact was nested under
// pondsh/node_modules — modern npm hoists peer copies up to the consumer's
// root node_modules, leaving that path nonexistent.
const moduleRequire = createRequire(import.meta.url)
const preactDir = path.dirname(moduleRequire.resolve("preact/package.json"))

// preact 11 renamed its dist builds (preact.module.js -> preact.mjs) and moved hooks/ and
// jsx-runtime/ under their own folders. Resolve each ESM entry from preact's own package
// exports so this alias map survives a major bump instead of pointing at files that no
// longer exist (preact 11 broke every client build until this was fixed).
function preactEntry(subpath: string): string {
  const pkg = moduleRequire("preact/package.json") as {
    exports?: Record<string, string | { default?: string; import?: string; module?: string }>
  }
  const entry = pkg.exports?.[subpath]
  const rel = typeof entry === "string" ? entry : (entry?.default ?? entry?.import ?? entry?.module)
  if (!rel) throw new Error(`preact has no ESM entry for "${subpath}"; check its package.json exports`)
  return path.join(preactDir, rel)
}

export async function buildClient(entry: string, options: { liveReload?: boolean } = {}): Promise<string> {
  // The capsule project root — the client entry is always <root>/client/index.tsx.
  const projectRoot = path.resolve(path.dirname(entry), "..")
  // esbuild reads the entry through symlinks: for hosted deploys a planted
  // symlink at client/index.tsx must not feed host files into the client
  // bundle (which the tenant serves back to visitors).
  if (!containedRealPath(projectRoot, entry)) {
    throw new Error("client entry must resolve inside the project directory")
  }
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
      "preact/jsx-runtime": preactEntry("./jsx-runtime"),
      "preact/jsx-dev-runtime": preactEntry("./jsx-runtime"),
      "preact/hooks": preactEntry("./hooks"),
      preact: preactEntry("."),
    },
    define: {
      "process.env.NODE_ENV": '"development"',
    },
    // Relative imports must not escape the capsule root (tenant-controlled
    // source on hosted deploys) — see build-confinement.ts.
    plugins: [confineImportsTo(projectRoot)],
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
  <style>
    /* Minimal safety net only. The template owns every visual decision —
       palette, type scale, components, spacing. Anything more here would
       force every capsule into the same "AI-default dark mode" look. */
    * { box-sizing: border-box; }
    html, body { margin: 0; background: #000; color: #fff; color-scheme: dark; }
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
