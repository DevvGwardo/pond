import { defineCommand } from "citty"
import { readDeployRecord } from "../host/deploy-record.js"
import { hasErrorCode } from "./inspect.js"

interface ResolvedTarget {
  baseUrl: string
  headers: Record<string, string>
  source: "explicit" | "auto-remote" | "local"
}

// Decide whether to hit the local dev server or the deploy in .pond/
// deploy.json.
//
//   --local true              → localhost:<port> (force)
//   target is http(s) URL     → that URL
//   target matches deploy.id  → deploy.url + claim-token header
//   target is unset, deploy
//     has remote url+token   → auto-remote (the common case from a deployed
//                              project — was previously a silent localhost
//                              call that confused users)
//   otherwise                 → localhost:<port>
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

export const logsCommand = defineCommand({
  meta: {
    name: "logs",
    description: "Stream capsule logs",
  },
  args: {
    port: {
      type: "string",
      default: "3000",
    },
    target: {
      type: "string",
      required: false,
      description: "deployId, full URL, or omit to auto-target the deploy in .pond/deploy.json",
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
      console.error(`→ Streaming logs from ${resolved.baseUrl}  (pass --local for the dev server)`)
    }
    let res: Response
    try {
      res = await fetch(`${resolved.baseUrl}/__pond/logs`, { headers: resolved.headers })
    } catch (err) {
      if (hasErrorCode(err, "ECONNREFUSED")) {
        console.error(`Could not reach ${resolved.baseUrl} — is the capsule running?`)
        console.error(`  Start it with: pond dev   (or: npm run dev)`)
        process.exit(1)
      }
      throw err
    }
    if (!res.ok || !res.body) {
      throw new Error(`Request failed: ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split("\n\n")
      buffer = events.pop() ?? ""
      for (const event of events) {
        const dataLine = event.split("\n").find((line) => line.startsWith("data: "))
        if (!dataLine) continue
        console.log(dataLine.slice(6))
      }
    }
  },
})
