// esbuild has no sandbox root: it resolves relative/absolute imports wherever
// they point, and reads entry files through symlinks. For a hosted deploy the
// tenant's source tree is untrusted, so without confinement a capsule could
// `import "../../host-token"` (or plant a symlink at the entry) and make the
// HOST's build step read arbitrary host files into the deploy bundle — which
// the tenant then reads back from its own directory.
import * as fs from "node:fs"
import * as path from "node:path"
import type { Plugin } from "esbuild"

// Reject any relative/absolute import that resolves outside `rootDir`.
// Imports in files outside `rootDir` (pond's own runtime sources behind the
// pond/server + pond/client aliases, node_modules packages) are trusted and
// skipped; bare imports (packages, node: builtins) are never touched.
export function confineImportsTo(rootDir: string): Plugin {
  // esbuild hands plugins realpath'd paths (its FS layer normalizes symlinks),
  // so a raw root would silently disable the guard whenever the project path
  // traverses a symlink (e.g. /tmp or /var on macOS). Resolve the root once
  // and compare realpaths throughout, or the guard fails OPEN.
  const root = fs.realpathSync(path.resolve(rootDir))
  return {
    name: "pond-confine-imports",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return undefined
        const p = args.path
        if (!p.startsWith(".") && !p.startsWith("/")) return undefined
        if (!args.resolveDir || !(args.resolveDir.startsWith(root + path.sep) || args.resolveDir === root)) {
          // Trusted code (pond runtime, node_modules) resolving its own imports.
          return undefined
        }
        const resolved = path.resolve(args.resolveDir, p)
        if (resolved === root || resolved.startsWith(root + path.sep)) {
          // Lexically inside the root. Also resolve symlinks on the final
          // target: esbuild reads files THROUGH symlinks, so a link planted
          // inside the tree must not be able to redirect the build to files
          // outside the root. (The host builds a freshly written staging tree,
          // so this is defense-in-depth on top of that.)
          let real: string
          try {
            real = fs.realpathSync(resolved)
          } catch {
            // Missing file — let esbuild produce its own resolution error.
            return undefined
          }
          if (real === root || real.startsWith(root + path.sep)) return undefined
          return {
            errors: [{ text: `import "${p}" escapes the project directory (${root})` }],
          }
        }
        return {
          errors: [{ text: `import "${p}" escapes the project directory (${root})` }],
        }
      })
    },
  }
}
