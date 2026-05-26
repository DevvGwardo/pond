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
    console.log(JSON.stringify(deploy, null, 2))
    return null
  }
  return deploy.url
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
    },
    port: {
      type: "string",
      default: "3000",
    },
  },
  async run({ args }) {
    const baseUrl = resolveBaseUrl(args.port, args.target)
    if (!baseUrl) return
    const res = await fetch(`${baseUrl}/__pond/inspect`)
    if (!res.ok) throw new Error(`Request failed: ${res.status}`)
    console.log(JSON.stringify(await res.json(), null, 2))
  },
})
