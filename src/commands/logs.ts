import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"

function resolveRemoteTarget(target?: string) {
  const deployFile = path.join(process.cwd(), ".pond", "deploy.json")
  if (!fs.existsSync(deployFile)) return null
  const deploy = JSON.parse(fs.readFileSync(deployFile, "utf-8")) as {
    deployId?: string
    url?: string
    claimToken?: string
  }
  if (!target) return null
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return {
      baseUrl: target.replace(/\/$/, ""),
      headers: {} as Record<string, string>,
    }
  }
  if (deploy.deployId === target && deploy.url) {
    return {
      baseUrl: deploy.url,
      headers: deploy.claimToken ? { "x-pond-claim-token": deploy.claimToken } : ({} as Record<string, string>),
    }
  }
  throw new Error(`Unknown deploy target: ${target}`)
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
    },
  },
  async run({ args }) {
    const target = typeof args.target === "string" ? args.target : undefined
    const remote = resolveRemoteTarget(target)
    const baseUrl = remote?.baseUrl ?? `http://localhost:${args.port}`
    const res = await fetch(`${baseUrl}/__pond/logs`, {
      headers: remote?.headers,
    })
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
        const dataLine = event
          .split("\n")
          .find((line) => line.startsWith("data: "))
        if (!dataLine) continue
        console.log(dataLine.slice(6))
      }
    }
  },
})
