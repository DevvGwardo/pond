// Shared fixtures + helpers for the pond test suite: the tiny capsule source
// used by most integration tests, the port picker, and the health waiter.
// These used to be copy-pasted across nine test files — keep them in one
// place so a fixture change updates every host test at once.
import * as path from "node:path"
import * as net from "node:net"

export const REPO_ROOT = path.resolve(import.meta.dirname, "..")
export const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js")

// Note: probe-then-bind has a TOCTOU window (the port is released before the
// spawned process binds). Callers that can should prefer `--port 0` and read
// the actual port from logs; this helper is for tests that need a concrete
// port up front and accept the tiny race on busy CI.
export async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

export async function waitForHealth(apiUrl, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${apiUrl}/api/health`)
      if (r.ok) return
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`host did not become healthy at ${apiUrl} within ${timeoutMs}ms`)
}

export const TINY_SERVER_SRC = `import { capsule, mutation, query, string, table } from "pond/server"
export default capsule({
  schema: { items: table({ name: string() }) },
  queries: { items: query((ctx) => ctx.db.items.all()) },
  mutations: { add: mutation((ctx, name) => ctx.db.items.insert({ name })) },
})
`

export function tinySourceFiles(serverSrc = TINY_SERVER_SRC, pkgJson) {
  return {
    "server/index.ts": serverSrc,
    "package.json": pkgJson ?? '{"name":"test-cap","private":true,"type":"module"}\n',
  }
}
