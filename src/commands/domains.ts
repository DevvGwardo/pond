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

function resolveApi(args: any): string {
  const argApi = typeof args?.api === "string" ? args.api.replace(/\/$/, "") : ""
  const local = readLocalDeploy()
  const apiUrl = argApi || local?.apiUrl || ""
  if (!apiUrl) {
    console.error("Need --api (or run from a deploy dir with .pond/deploy.json).")
    process.exit(1)
  }
  return apiUrl
}

function authHeader(apiUrl: string): Record<string, string> {
  const cred = loadCredentials(apiUrl)
  if (!cred) {
    console.error(`No saved credentials for ${apiUrl}. Run \`pond login\` first.`)
    process.exit(1)
  }
  return { authorization: `Bearer ${cred.token}` }
}

export const domainsCommand = defineCommand({
  meta: {
    name: "domains",
    description: "Manage custom subdomains for hosted deploys",
  },
  subCommands: {
    list: defineCommand({
      meta: { name: "list" },
      args: {
        api: { type: "string", required: false },
      },
      async run({ args }) {
        const apiUrl = resolveApi(args)
        const res = await fetch(`${apiUrl}/api/domains`, { headers: authHeader(apiUrl) })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          console.error(`List failed: ${res.status} ${text}`)
          process.exit(1)
        }
        const out = (await res.json()) as { domains: Array<{ subdomain: string; deployId: string; createdAt: string }> }
        if (out.domains.length === 0) {
          console.log("(no custom domains)")
          return
        }
        for (const d of out.domains) {
          console.log(`${d.subdomain}\t${d.deployId}\t${d.createdAt}`)
        }
      },
    }),
    add: defineCommand({
      meta: { name: "add" },
      args: {
        subdomain: { type: "positional", required: true },
        deployId: { type: "positional", required: false },
        api: { type: "string", required: false },
      },
      async run({ args }) {
        const subdomain = String(args.subdomain)
        const local = readLocalDeploy()
        const deployId = (typeof args.deployId === "string" && args.deployId) || local?.deployId || ""
        if (!deployId) {
          console.error("Need deployId (positional) or run from a deploy dir.")
          process.exit(1)
        }
        const apiUrl = resolveApi(args)
        const res = await fetch(`${apiUrl}/api/domains`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeader(apiUrl) },
          body: JSON.stringify({ subdomain, deployId }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          console.error(`Add failed: ${res.status} ${text}`)
          process.exit(1)
        }
        const out = (await res.json()) as { subdomain: string; deployId: string; url?: string }
        console.log(`Added ${out.subdomain} → ${out.deployId}`)
        if (out.url) console.log(out.url)
      },
    }),
    remove: defineCommand({
      meta: { name: "remove" },
      args: {
        subdomain: { type: "positional", required: true },
        api: { type: "string", required: false },
      },
      async run({ args }) {
        const subdomain = String(args.subdomain)
        const apiUrl = resolveApi(args)
        const res = await fetch(`${apiUrl}/api/domains/${encodeURIComponent(subdomain)}`, {
          method: "DELETE",
          headers: authHeader(apiUrl),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          console.error(`Remove failed: ${res.status} ${text}`)
          process.exit(1)
        }
        console.log(`Removed ${subdomain}.`)
      },
    }),
  },
})
