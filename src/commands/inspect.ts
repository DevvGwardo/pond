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
    const target = typeof args.target === "string" ? args.target : undefined
    const remote = resolveRemoteTarget(target)
    const baseUrl = remote?.baseUrl ?? `http://localhost:${args.port}`
    let res: Response
    try {
      res = await fetch(`${baseUrl}/__pond/inspect`, {
        headers: remote?.headers,
      })
    } catch (err) {
      const code = (err as { cause?: { code?: string } })?.cause?.code
      if (code === "ECONNREFUSED") {
        console.error(`Could not reach ${baseUrl} — is the capsule running?`)
        console.error(`  Start it with: pond dev   (or: npm run dev)`)
        process.exit(1)
      }
      throw err
    }
    if (!res.ok) throw new Error(`Request failed: ${res.status}`)
    console.log(JSON.stringify(await res.json(), null, 2))
  },
})
