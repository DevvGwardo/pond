import * as esbuild from "esbuild"
import * as path from "node:path"

export async function buildClient(entry: string, options: { liveReload?: boolean } = {}): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: false,
    write: false,
    format: "esm",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "preact",
    alias: {
      "pond/client": path.resolve(import.meta.dirname, "../client/index.ts"),
      "preact/jsx-runtime": path.resolve(import.meta.dirname, "../node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js"),
      "preact/jsx-dev-runtime": path.resolve(import.meta.dirname, "../node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js"),
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
  ${options.liveReload ? `<script>
    const es = new EventSource('/__pond_reload')
    es.onmessage = () => location.reload()
  </script>` : ""}
  <script type="module">
    import { render, h } from "https://esm.sh/preact@10.24.0";
    import { htm } from "https://esm.sh/htm@3.1.1";
    const html = htm.bind(h);

    ${js}

    const root = document.getElementById("root");
    render(html\`<\${App} />\`, root);
  </script>
</body>
</html>`
}
