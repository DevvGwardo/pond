import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"

function resolveBaseUrl(port: string, target?: string) {
  if (!target) return `http://localhost:${port}`
  const deployFile = path.join(process.cwd(), ".pond", "deploy.json")
  if (!fs.existsSync(deployFile)) {
    throw new Error("No .pond/deploy.json found")
  }
  const deploy = JSON.parse(fs.readFileSync(deployFile, "utf-8")) as {
    deployId: string
    url?: string
  }
  if (deploy.deployId !== target) {
    throw new Error(`Unknown deploy id: ${target}`)
  }
  if (!deploy.url) {
    throw new Error("Deploy has no remote URL")
  }
  return deploy.url
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
    const baseUrl = resolveBaseUrl(args.port, args.target)
    const res = await fetch(`${baseUrl}/__pond/logs`)
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
