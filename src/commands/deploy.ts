import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { buildForDeploy } from "../runtime.js"
import { buildClient } from "../bundler.js"
import { loadCredentials } from "../host/credentials.js"

function formatRelative(targetIso: string | undefined, fromMs: number): string {
  if (!targetIso) return ""
  const diff = new Date(targetIso).getTime() - fromMs
  if (!isFinite(diff)) return ""
  const s = Math.max(1, Math.round(diff / 1000))
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"}`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? "" : "s"}`
}

export const deployCommand = defineCommand({
  meta: {
    name: "deploy",
    description: "Deploy the capsule",
  },
  args: {
    port: {
      type: "string",
      description: "Port to use when starting the deployed bundle",
      default: "3000",
    },
    api: {
      type: "string",
      description: "Control-plane API URL for hosted deploys",
      required: false,
    },
    token: {
      type: "string",
      description: "User API token (overrides ~/.pond/credentials.json)",
      required: false,
    },
    "public-inspect": {
      type: "boolean",
      description: "Allow hosted inspection endpoints without a claim token",
      default: false,
    },
    "push-env": {
      type: "boolean",
      description: "Upload .env.pond.server to the control plane on this deploy",
      default: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd()
    const serverFile = path.join(cwd, "server", "index.ts")
    const clientFile = path.join(cwd, "client", "index.tsx")
    const envFile = path.join(cwd, ".env.pond.server")
    const deployDir = path.join(cwd, ".pond")
    const deployFile = path.join(deployDir, "deploy.json")
    const deployId = randomBytes(8).toString("hex")
    const { outfile, hash } = await buildForDeploy(serverFile, cwd)
    const clientPath = path.join(deployDir, "client.html")
    const clientHtml = fs.existsSync(clientFile) ? await buildClient(clientFile) : undefined
    const apiUrl = typeof args.api === "string" && args.api ? args.api.replace(/\/$/, "") : undefined

    if (apiUrl) {
      try {
        const parsed = new URL(apiUrl)
        const isLoopback =
          parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1"
        if (parsed.protocol === "http:" && !isLoopback) {
          console.error(
            `⚠  --api ${apiUrl} uses plain http:// — credentials and claim tokens will be sent in clear. Use https:// for any non-loopback host.`,
          )
        }
      } catch {
        // invalid URL is handled later by fetch
      }
    }

    fs.mkdirSync(deployDir, { recursive: true })
    if (clientHtml) {
      fs.writeFileSync(clientPath, clientHtml)
    }

    const localRecord = fs.existsSync(deployFile)
      ? (JSON.parse(fs.readFileSync(deployFile, "utf-8")) as {
          apiUrl?: string
          deployId?: string
          claimToken?: string
          claimedAt?: string
        })
      : null

    if (!apiUrl) {
      fs.writeFileSync(
        deployFile,
        JSON.stringify(
          {
            deployId,
            timestamp: new Date().toISOString(),
            bundleHash: hash,
            bundlePath: outfile,
            clientPath: clientHtml ? clientPath : undefined,
            port: parseInt(args.port, 10),
          },
          null,
          2,
        ),
      )

      console.log("Deployed! Run `pond start` to serve, or set PORT= env var")
      return
    }

    const userToken = (typeof args.token === "string" && args.token) || loadCredentials(apiUrl)?.token || ""

    const bundleBytes = fs.readFileSync(outfile)
    const shouldPushEnv = Boolean(args["push-env"])
    const envText = shouldPushEnv && fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : undefined

    const isAnonymous = !userToken && !localRecord?.claimToken

    console.log(
      `→ Uploading bundle (${(bundleBytes.length / 1024).toFixed(1)} KB) to ${apiUrl}${isAnonymous ? " (anonymous)" : ""}`,
    )
    if (shouldPushEnv) {
      if (isAnonymous) {
        console.error("--push-env is not allowed for anonymous deploys; claim first.")
        process.exit(1)
      }
      const lineCount = envText ? envText.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length : 0
      console.log(`→ Uploading .env.pond.server (${lineCount} entries) to ${apiUrl}`)
    }

    const baseBody = {
      bundleBase64: Buffer.from(bundleBytes).toString("base64"),
      clientHtmlBase64: clientHtml ? Buffer.from(clientHtml).toString("base64") : undefined,
      publicInspect: Boolean(args["public-inspect"]),
    }

    let response: Response

    if (localRecord?.apiUrl === apiUrl && localRecord.deployId && (localRecord.claimToken || userToken)) {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (userToken) headers.authorization = `Bearer ${userToken}`
      if (localRecord.claimToken) headers["x-pond-claim-token"] = localRecord.claimToken
      response = await fetch(`${apiUrl}/api/deploys/${localRecord.deployId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...baseBody, envText }),
      })
    } else {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (userToken) headers.authorization = `Bearer ${userToken}`
      response = await fetch(`${apiUrl}/api/deploys`, {
        method: "POST",
        headers,
        body: JSON.stringify(baseBody),
      })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Hosted deploy failed: ${response.status} ${text}`)
    }

    const remote = (await response.json()) as {
      deployId: string
      claimToken: string
      url: string
      apiUrl: string
      publicInspect: boolean
      claimedAt?: string
      updatedAt?: string
      terminatesAt?: string
      expiresAt?: string
    }

    fs.writeFileSync(
      deployFile,
      JSON.stringify(
        {
          deployId: remote.deployId,
          timestamp: remote.updatedAt ?? new Date().toISOString(),
          bundleHash: hash,
          bundlePath: outfile,
          clientPath: clientHtml ? clientPath : undefined,
          apiUrl: remote.apiUrl,
          url: remote.url,
          claimToken: remote.claimToken,
          publicInspect: remote.publicInspect,
          claimedAt: remote.claimedAt,
          terminatesAt: remote.terminatesAt,
          expiresAt: remote.expiresAt,
          port: parseInt(args.port, 10),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    try {
      fs.chmodSync(deployFile, 0o600)
    } catch {
      // best-effort on platforms without chmod (e.g. Windows)
    }

    if (isAnonymous && remote.terminatesAt && remote.expiresAt) {
      const now = Date.now()
      const terminatesIn = formatRelative(remote.terminatesAt, now)
      const expiresIn = formatRelative(remote.expiresAt, now)
      console.log(`Hosted deploy created at ${remote.url}`)
      console.log(`  ⚠ Anonymous — terminates in ${terminatesIn}, deleted in ${expiresIn}`)
      console.log(`  Claim with: pond claim --signup <username>`)
      console.log(`          or: pond login --api ${remote.apiUrl} --username <name> first, then \`pond claim\``)
    } else {
      console.log(`Hosted deploy ${remote.claimedAt ? "updated" : "created"} at ${remote.url}`)
      console.log(`Manage env with: pond env list ${remote.deployId} --api ${remote.apiUrl}`)
    }
  },
})
