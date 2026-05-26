import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { loadCredentials } from "../host/credentials.js"

function readLocalDeploy(): { deployId: string; apiUrl: string } | null {
  const file = path.join(process.cwd(), ".pond", "deploy.json")
  if (!fs.existsSync(file)) return null
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf-8")) as { deployId?: string; apiUrl?: string }
    if (j.deployId && j.apiUrl) return { deployId: j.deployId, apiUrl: j.apiUrl }
    return null
  } catch {
    return null
  }
}

function resolveTarget(args: any): { deployId: string; apiUrl: string } {
  const argDeployId = typeof args?.deployId === "string" ? args.deployId : ""
  const argApi = typeof args?.api === "string" ? args.api.replace(/\/$/, "") : ""
  const local = readLocalDeploy()
  const deployId = argDeployId || local?.deployId || ""
  const apiUrl = argApi || local?.apiUrl || ""
  if (!deployId || !apiUrl) {
    console.error("Need deployId and --api. Run from a deploy dir, or pass both explicitly.")
    process.exit(1)
  }
  return { deployId, apiUrl }
}

function authHeader(apiUrl: string): Record<string, string> {
  const cred = loadCredentials(apiUrl)
  if (!cred) {
    console.error(`No saved credentials for ${apiUrl}. Run \`pond login\` first.`)
    process.exit(1)
  }
  return { authorization: `Bearer ${cred.token}` }
}

export const envCommand = defineCommand({
  meta: {
    name: "env",
    description: "Manage hosted deploy env vars (.env.pond.server)",
  },
  subCommands: {
    list: defineCommand({
      meta: { name: "list" },
      args: {
        deployId: { type: "positional", required: false },
        api: { type: "string", required: false },
      },
      async run({ args }) {
        const { deployId, apiUrl } = resolveTarget(args)
        const res = await fetch(`${apiUrl}/api/deploys/${deployId}/env`, { headers: authHeader(apiUrl) })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          console.error(`List failed: ${res.status} ${text}`)
          process.exit(1)
        }
        const out = (await res.json()) as { entries: Record<string, string> }
        for (const [k, v] of Object.entries(out.entries)) {
          console.log(`${k}=${v}`)
        }
      },
    }),
    set: defineCommand({
      meta: { name: "set" },
      args: {
        deployId: { type: "positional", required: true },
        kvs: { type: "positional", required: true, description: "KEY=value pairs" },
        api: { type: "string", required: false },
      },
      async run({ args }) {
        const a = args as any
        const positional: string[] = Array.isArray(a._) ? a._ : []
        if (positional.length < 2) {
          console.error("Usage: pond env set <deployId> KEY=value [KEY=value ...]")
          process.exit(1)
        }
        const deployIdStr = String(positional[0])
        const { apiUrl } = resolveTarget({ deployId: deployIdStr, api: a.api })
        const pairs: Array<[string, string]> = []
        for (const c of positional.slice(1)) {
          const idx = c.indexOf("=")
          if (idx === -1) {
            console.error(`Bad pair: ${c} (expected KEY=value)`)
            process.exit(1)
          }
          pairs.push([c.slice(0, idx), c.slice(idx + 1)])
        }
        const entries: Record<string, string> = {}
        for (const [k, v] of pairs) entries[k] = v
        const res = await fetch(`${apiUrl}/api/deploys/${deployIdStr}/env`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...authHeader(apiUrl) },
          body: JSON.stringify({ entries }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          console.error(`Set failed: ${res.status} ${text}`)
          process.exit(1)
        }
        const out = (await res.json()) as { entries: Record<string, string> }
        console.log(`Updated. ${Object.keys(out.entries).length} entries on deploy ${deployIdStr}.`)
      },
    }),
    unset: defineCommand({
      meta: { name: "unset" },
      args: {
        deployId: { type: "positional", required: true },
        key: { type: "positional", required: true },
        api: { type: "string", required: false },
      },
      async run({ args }) {
        const deployIdStr = String(args.deployId)
        const keyStr = String(args.key)
        const { apiUrl } = resolveTarget({ deployId: deployIdStr, api: args.api })
        const res = await fetch(`${apiUrl}/api/deploys/${deployIdStr}/env/${encodeURIComponent(keyStr)}`, {
          method: "DELETE",
          headers: authHeader(apiUrl),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          console.error(`Unset failed: ${res.status} ${text}`)
          process.exit(1)
        }
        console.log(`Removed ${keyStr} from deploy ${deployIdStr}.`)
      },
    }),
  },
})
