import { defineCommand, renderUsage } from "citty"
import { loadCredentials } from "../host/credentials.js"
import { readDeployRecord } from "../host/deploy-record.js"

// See dbCommand for why this pattern exists. citty's default behavior on a
// bare subcommand-group invocation is to print help AND exit 1 with "ERROR
// No command specified" — this gives users a clean exit 0 with help instead.
async function showGroupUsageIfBare({ args, cmd }: { args: Record<string, unknown>; cmd: unknown }) {
  const positionals = (args._ as string[] | undefined) ?? []
  if (positionals.length > 0) return
  console.log(await renderUsage(cmd as Parameters<typeof renderUsage>[0]))
}

function readLocalDeploy(): { deployId: string; apiUrl: string } | null {
  const j = readDeployRecord(process.cwd())
  if (j?.deployId && j?.apiUrl) return { deployId: j.deployId, apiUrl: j.apiUrl }
  return null
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
  run: showGroupUsageIfBare,
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
