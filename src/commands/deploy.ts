import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { buildForDeploy } from "../runtime.js"
import { buildClient } from "../bundler.js"
import { loadCredentials } from "../host/credentials.js"
import { readDeployRecord } from "../host/deploy-record.js"

const SOURCE_ROOTS = ["server", "client", "shared"]
const SOURCE_FILE_LIMIT = 200
const SOURCE_TOTAL_LIMIT = 4 * 1024 * 1024

export function collectSourceFiles(cwd: string): Record<string, string> {
  const out: Record<string, string> = {}
  let total = 0
  let count = 0
  const walk = (rel: string) => {
    const abs = path.join(cwd, rel)
    if (!fs.existsSync(abs)) return
    const stat = fs.statSync(abs)
    if (stat.isFile()) {
      const text = fs.readFileSync(abs, "utf-8")
      out[rel.split(path.sep).join("/")] = text
      total += Buffer.byteLength(text, "utf-8")
      count += 1
      if (count > SOURCE_FILE_LIMIT) {
        throw new Error(`Source tree exceeds ${SOURCE_FILE_LIMIT} files`)
      }
      if (total > SOURCE_TOTAL_LIMIT) {
        throw new Error(`Source tree exceeds ${SOURCE_TOTAL_LIMIT} bytes total`)
      }
      return
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs)) {
        if (entry === "node_modules" || entry === ".pond" || entry.startsWith(".")) continue
        walk(path.join(rel, entry))
      }
    }
  }
  for (const root of SOURCE_ROOTS) walk(root)
  const pkgPath = path.join(cwd, "package.json")
  if (fs.existsSync(pkgPath)) {
    out["package.json"] = fs.readFileSync(pkgPath, "utf-8")
  }
  if (!out["server/index.ts"]) {
    throw new Error("server/index.ts is required for a hosted deploy")
  }
  return out
}

function slugifySubdomain(raw: string): string {
  // Server rule (host.ts /api/domains): DNS label — a-z, 0-9, hyphens; max 63; no leading/trailing hyphen.
  // Cap at 40 to leave headroom for a "-NN" collision suffix.
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
  return slug
}

async function tryAliasDomain(opts: {
  apiUrl: string
  deployId: string
  baseSlug: string
  userToken: string
}): Promise<string | undefined> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.userToken}`,
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = attempt === 0 ? opts.baseSlug : `${opts.baseSlug}-${attempt + 1}`
    if (!candidate) return undefined
    const res = await fetch(`${opts.apiUrl}/api/domains`, {
      method: "POST",
      headers,
      body: JSON.stringify({ subdomain: candidate, deployId: opts.deployId }),
    })
    if (res.ok) {
      const out = (await res.json().catch(() => ({}))) as { subdomain?: string; url?: string }
      return out.subdomain ?? candidate
    }
    if (res.status === 409) continue
    // 400 (invalid/reserved/hex-collision) or 401 — stop trying, alias not happening.
    return undefined
  }
  return undefined
}

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
    local: {
      type: "boolean",
      description: "Build an offline bundle in .pond/ instead of uploading to a hosted control plane",
      default: false,
    },
    "no-auto-domain": {
      type: "boolean",
      description: "Skip auto-aliasing the deploy to <package.json name>.<host> on first deploy",
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

    fs.mkdirSync(deployDir, { recursive: true })

    const localRecord = readDeployRecord(cwd)

    // Decide the deploy target:
    //   --local              → offline build, no upload
    //   --api X              → use X
    //   prior hosted record  → redeploy to the same control plane (so plain
    //                          `pond deploy` updates an existing hosted app)
    //   otherwise            → https://pond.run, with a visible upload notice
    const argApi = typeof args.api === "string" && args.api ? args.api.replace(/\/$/, "") : undefined
    const wantLocal = Boolean(args["local"])
    let apiUrl: string | undefined
    let usingHostedDefault = false
    if (wantLocal) {
      apiUrl = undefined
    } else if (argApi) {
      apiUrl = argApi
    } else if (localRecord?.apiUrl) {
      apiUrl = localRecord.apiUrl
    } else {
      apiUrl = "https://pond.run"
      usingHostedDefault = true
    }

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

    if (usingHostedDefault) {
      console.log(
        `→ No deploy target set; uploading to https://pond.run (anonymous). Pass --local to build offline instead.`,
      )
    }

    if (!apiUrl) {
      const { outfile, hash } = await buildForDeploy(serverFile, cwd)
      const clientPath = path.join(deployDir, "client.html")
      const clientHtml = fs.existsSync(clientFile) ? await buildClient(clientFile) : undefined
      if (clientHtml) {
        fs.writeFileSync(clientPath, clientHtml)
      }
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

    const sourceFiles = collectSourceFiles(cwd)
    const totalSourceBytes = Object.values(sourceFiles).reduce((n, c) => n + Buffer.byteLength(c, "utf-8"), 0)

    const shouldPushEnv = Boolean(args["push-env"])
    const envText = shouldPushEnv && fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : undefined

    const isAnonymous = !userToken && !localRecord?.claimToken

    console.log(
      `→ Uploading source (${Object.keys(sourceFiles).length} files, ${(totalSourceBytes / 1024).toFixed(1)} KB) to ${apiUrl}${isAnonymous ? " (anonymous)" : ""}`,
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
      sourceFiles,
      publicInspect: Boolean(args["public-inspect"]),
    }

    let response: Response
    let isNewDeploy = false

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
      isNewDeploy = true
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Hosted deploy failed: ${response.status} ${text}`)
    }

    const remote = (await response.json()) as {
      deployId: string
      claimToken?: string
      url: string
      apiUrl: string
      publicInspect: boolean
      bundleHash?: string
      bundleBytes?: number
      claimedAt?: string
      updatedAt?: string
      terminatesAt?: string
      expiresAt?: string
    }

    // Use the apiUrl WE deployed to, not the server's echoed `remote.apiUrl`.
    // Some control planes (incl. current pond.run) echo back their internal
    // bind address (e.g. http://0.0.0.0:8787) which would make every printed
    // link unusable. The user reached this server through `apiUrl`; that's
    // the authoritative public address.
    const effectiveApiUrl = apiUrl

    fs.writeFileSync(
      deployFile,
      JSON.stringify(
        {
          deployId: remote.deployId,
          timestamp: remote.updatedAt ?? new Date().toISOString(),
          bundleHash: remote.bundleHash,
          apiUrl: effectiveApiUrl,
          url: remote.url,
          // PUT responses no longer echo the plaintext claimToken (server
          // stores only the hash). Fall back to the locally cached token —
          // it didn't rotate.
          claimToken: remote.claimToken ?? localRecord?.claimToken,
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

    // Auto-alias new deploys to a slug of package.json `name`, so the printed
    // URL is `bento-dash.pond.run` instead of `cd8a6d5d…pond.run`. Only on
    // first creation, only when logged in (anonymous deploys can't claim
    // /api/domains), and only when not disabled with --no-auto-domain.
    let aliasUrl: string | undefined
    if (isNewDeploy && userToken && !args["no-auto-domain"]) {
      try {
        const pkgRaw = sourceFiles["package.json"]
        const pkgName = pkgRaw ? (JSON.parse(pkgRaw) as { name?: string }).name : undefined
        const baseSlug = pkgName ? slugifySubdomain(pkgName) : ""
        if (baseSlug) {
          const subdomain = await tryAliasDomain({
            apiUrl: effectiveApiUrl,
            deployId: remote.deployId,
            baseSlug,
            userToken,
          })
          if (subdomain) {
            try {
              const u = new URL(effectiveApiUrl)
              aliasUrl = `${u.protocol}//${subdomain}.${u.host}`
            } catch {
              // effectiveApiUrl was unparseable; skip pretty URL.
            }
          }
        }
      } catch {
        // Auto-alias is best-effort. A bad package.json or transient API
        // failure shouldn't fail the deploy.
      }
    }

    const ideUrl = isAnonymous
      ? `${effectiveApiUrl}/ide/${remote.deployId}#token=${remote.claimToken}`
      : `${effectiveApiUrl}/ide/${remote.deployId}`
    const dashboardUrl = `${effectiveApiUrl}/dashboard`
    if (isAnonymous && remote.terminatesAt && remote.expiresAt) {
      const now = Date.now()
      const terminatesIn = formatRelative(remote.terminatesAt, now)
      const expiresIn = formatRelative(remote.expiresAt, now)
      console.log(`Hosted deploy created at ${remote.url}`)
      console.log(`  IDE: ${ideUrl}`)
      console.log(`  ⚠ Anonymous — terminates in ${terminatesIn}, deleted in ${expiresIn}`)
      console.log(`  Claim with: pond signup <username>`)
      console.log(`   (or alias: pond claim --signup <username>)`)
    } else {
      const primaryUrl = aliasUrl ?? remote.url
      console.log(`Hosted deploy ${remote.claimedAt ? "updated" : "created"} at ${primaryUrl}`)
      if (aliasUrl) console.log(`  (also: ${remote.url})`)
      console.log(`  IDE: ${ideUrl}`)
      console.log(`  Dashboard: ${dashboardUrl}`)
      console.log(`Manage env with: pond env list ${remote.deployId} --api ${effectiveApiUrl}`)
    }
  },
})
