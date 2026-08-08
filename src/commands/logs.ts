import { defineCommand } from "citty"
import { fail, hasErrorCode, resolveTarget } from "./shared.js"

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
      fail(`Request failed: HTTP ${res.status} ${res.url}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
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
      // Flush a trailing event that never got its \n\n terminator (the
      // capsule died mid-line, or the stream ended between events).
      const dataLine = buffer.split("\n").find((line) => line.startsWith("data: "))
      if (dataLine) console.log(dataLine.slice(6))
    } catch (err) {
      if (hasErrorCode(err, "ECONNRESET")) {
        console.error("Log stream ended (the capsule restarted or shut down).")
        process.exit(0)
      }
      throw err
    }
  },
})
