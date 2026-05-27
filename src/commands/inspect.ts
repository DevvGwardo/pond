import { defineCommand } from "citty"
import { readDeployRecord } from "../host/deploy-record.js"

interface ResolvedTarget {
  baseUrl: string
  headers: Record<string, string>
  source: "explicit" | "auto-remote" | "local"
}

// See logs.ts:resolveTarget for the resolution matrix. Same rules: --local
// forces localhost, explicit URL/deployId wins, otherwise auto-target the
// deploy in .pond/deploy.json, otherwise localhost.
function resolveTarget(target: string | undefined, port: string, local: boolean): ResolvedTarget {
  const localhostUrl = `http://localhost:${port}`
  if (local) {
    return { baseUrl: localhostUrl, headers: {}, source: "local" }
  }
  const deploy = readDeployRecord(process.cwd())
  if (target) {
    if (target.startsWith("http://") || target.startsWith("https://")) {
      return { baseUrl: target.replace(/\/$/, ""), headers: {}, source: "explicit" }
    }
    if (deploy?.deployId === target && deploy?.url) {
      const headers: Record<string, string> = deploy.claimToken ? { "x-pond-claim-token": deploy.claimToken } : {}
      return { baseUrl: deploy.url, headers, source: "explicit" }
    }
    throw new Error(`Unknown deploy target: ${target}`)
  }
  if (deploy?.url && deploy?.claimToken) {
    return {
      baseUrl: deploy.url,
      headers: { "x-pond-claim-token": deploy.claimToken },
      source: "auto-remote",
    }
  }
  return { baseUrl: localhostUrl, headers: {}, source: "local" }
}

// Walk `err.cause` and any AggregateError.errors[] looking for a matching
// error code. Node's undici uses happy-eyeballs on dual-stack hosts (`localhost`
// → IPv4 + IPv6 in parallel); when both families refuse, `err.cause` is an
// AggregateError, not a single Error with `.code`. Without this walker the
// caller's friendly "is the capsule running?" message never fires and the
// raw undici stack leaks. Bounded depth so a malformed chain can't loop.
export function hasErrorCode(err: unknown, target: string, depth = 0): boolean {
  if (depth > 5 || err == null) return false
  if (typeof err === "object") {
    const e = err as { code?: unknown; cause?: unknown; errors?: unknown }
    if (typeof e.code === "string" && e.code === target) return true
    if (Array.isArray(e.errors)) {
      for (const sub of e.errors) {
        if (hasErrorCode(sub, target, depth + 1)) return true
      }
    }
    if (e.cause && e.cause !== err) {
      if (hasErrorCode(e.cause, target, depth + 1)) return true
    }
  }
  return false
}

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
    if (!res.ok) throw new Error(`Request failed: ${res.status}`)
    console.log(JSON.stringify(await res.json(), null, 2))
  },
})
