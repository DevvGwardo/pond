import { defineCommand } from "citty"
import { fail, httpError, hasErrorCode, resolveTarget } from "./shared.js"

export const inspectCommand = defineCommand({
  meta: {
    name: "inspect",
    description: "Inspect a running capsule",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      description: "deployId, full URL, or omit to auto-target the deploy in .pond/deploy.json",
    },
    port: {
      type: "string",
      default: "3000",
    },
    local: {
      type: "boolean",
      default: false,
      description: "Force localhost:<port> even if .pond/deploy.json points at a remote deploy",
    },
  },
  async run({ args }) {
    const target = typeof args.target === "string" ? args.target : undefined
    const port = typeof args.port === "string" ? args.port : "3000"
    const local = Boolean(args.local)
    const resolved = resolveTarget(target, port, local)
    if (resolved.source === "auto-remote") {
      console.error(`→ Inspecting ${resolved.baseUrl}  (pass --local for the dev server)`)
    }
    let res: Response
    try {
      res = await fetch(`${resolved.baseUrl}/__pond/inspect`, { headers: resolved.headers })
    } catch (err) {
      if (hasErrorCode(err, "ECONNREFUSED")) {
        console.error(`Could not reach ${resolved.baseUrl} — is the capsule running?`)
        console.error(`  Start it with: pond dev   (or: npm run dev)`)
        process.exit(1)
      }
      throw err
    }
    if (!res.ok) {
      await httpError(res, "Request")
    }
    console.log(JSON.stringify(await res.json(), null, 2))
  },
})
