import { defineCommand } from "citty"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { bodyLimit } from "hono/body-limit"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { fork, type ChildProcess } from "node:child_process"
import { openControlDb, DEFAULT_QUOTA, ANONYMOUS_QUOTA, type ControlDb, type UserRow } from "../host/control-db.js"
import { createHash } from "node:crypto"
import { buildForDeploy } from "../runtime.js"
import { buildClient } from "../bundler.js"
import { ideHtml } from "../ide/built.js"

const SOURCE_FILE_LIMIT = 200
const SOURCE_TOTAL_LIMIT = 4 * 1024 * 1024
const SOURCE_PATH_RE = /^(server|client|shared)\/[a-zA-Z0-9_./-]+$|^package\.json$/

function validateSourceFiles(
  input: unknown,
): { ok: true; files: Record<string, string> } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "sourceFiles must be an object" }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return { ok: false, error: "sourceFiles is empty" }
  if (entries.length > SOURCE_FILE_LIMIT) return { ok: false, error: `Too many files (max ${SOURCE_FILE_LIMIT})` }
  let total = 0
  const out: Record<string, string> = {}
  let hasServerEntry = false
  for (const [rel, content] of entries) {
    if (typeof content !== "string") return { ok: false, error: `File ${rel} is not a string` }
    if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) {
      return { ok: false, error: `Invalid path: ${rel}` }
    }
    if (!SOURCE_PATH_RE.test(rel)) {
      return { ok: false, error: `Path not allowed: ${rel}` }
    }
    total += Buffer.byteLength(content, "utf-8")
    if (total > SOURCE_TOTAL_LIMIT) return { ok: false, error: `Source exceeds ${SOURCE_TOTAL_LIMIT} bytes` }
    out[rel] = content
    if (rel === "server/index.ts") hasServerEntry = true
  }
  if (!hasServerEntry) return { ok: false, error: "server/index.ts is required" }
  return { ok: true, files: out }
}

function writeSourceTree(deployDir: string, files: Record<string, string>): void {
  const sourceDir = path.join(deployDir, "source")
  fs.rmSync(sourceDir, { recursive: true, force: true })
  fs.mkdirSync(sourceDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(sourceDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
}

async function buildDeployFromSource(deployDir: string): Promise<{ bundleBytes: number; bundleHash: string }> {
  const sourceDir = path.join(deployDir, "source")
  const serverFile = path.join(sourceDir, "server", "index.ts")
  const clientFile = path.join(sourceDir, "client", "index.tsx")
  const outfile = path.join(deployDir, "deploy-bundle.mjs")
  await buildForDeploy(serverFile, sourceDir, outfile)
  if (fs.existsSync(clientFile)) {
    const html = await buildClient(clientFile)
    fs.writeFileSync(path.join(deployDir, "client.html"), html)
  } else {
    const stale = path.join(deployDir, "client.html")
    if (fs.existsSync(stale)) fs.rmSync(stale)
  }
  const bundleBuf = fs.readFileSync(outfile)
  const bundleHash = createHash("sha256").update(bundleBuf).digest("hex")
  return { bundleBytes: bundleBuf.length, bundleHash }
}

interface HostedDeployRecord {
  deployId: string
  claimToken: string
  appPort: number
  url: string
  apiUrl: string
  publicInspect: boolean
  createdAt: string
  updatedAt: string
  claimedAt?: string
  bootError?: string
}

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024
const MAX_ENV_BYTES = 64 * 1024
const MAX_ENV_ENTRIES = 256
const MAX_ENV_VALUE_CHARS = 1024

const RESERVED_SUBDOMAINS = new Set(["api", "admin", "docs", "www", "app", "health"])
const SUBDOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const HEX_DEPLOY_ID_RE = /^[a-f0-9]{16}$/
const MAX_DOMAINS_PER_USER = 50

function dirSize(dir: string): number {
  let total = 0
  if (!fs.existsSync(dir)) return 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.isFile()) {
        try {
          total += fs.statSync(p).size
        } catch {
          // ignore
        }
      }
    }
  }
  return total
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function bearer(header: string | undefined): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

function validateEnvText(text: string): { ok: true } | { ok: false; error: string } {
  if (Buffer.byteLength(text, "utf8") > MAX_ENV_BYTES) {
    return { ok: false, error: `envText exceeds ${MAX_ENV_BYTES} bytes` }
  }
  const parsed = parseEnvText(text)
  const keys = Object.keys(parsed)
  if (keys.length > MAX_ENV_ENTRIES) {
    return { ok: false, error: `envText exceeds ${MAX_ENV_ENTRIES} entries` }
  }
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      return { ok: false, error: `invalid env key: ${k}` }
    }
    if ((parsed[k] ?? "").length > MAX_ENV_VALUE_CHARS) {
      return { ok: false, error: `env value for ${k} exceeds ${MAX_ENV_VALUE_CHARS} chars` }
    }
  }
  return { ok: true }
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx === -1) continue
    out[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
  }
  return out
}

function serializeEnv(entries: Record<string, string>): string {
  return (
    Object.keys(entries)
      .sort()
      .map((k) => `${k}=${entries[k] ?? ""}`)
      .join("\n") + "\n"
  )
}

function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(s.trim())
  if (!m) throw new Error(`invalid duration: ${s}`)
  const n = parseInt(m[1], 10)
  switch (m[2]) {
    case "ms":
      return n
    case "s":
      return n * 1000
    case "m":
      return n * 60 * 1000
    case "h":
      return n * 60 * 60 * 1000
    case "d":
      return n * 24 * 60 * 60 * 1000
    default:
      throw new Error(`invalid duration unit: ${m[2]}`)
  }
}

function formatHumanDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s % 86400 === 0) return `${s / 86400} day${s / 86400 === 1 ? "" : "s"}`
  if (s % 3600 === 0) return `${s / 3600} hour${s / 3600 === 1 ? "" : "s"}`
  if (s % 60 === 0) return `${s / 60} minute${s / 60 === 1 ? "" : "s"}`
  return `${s} second${s === 1 ? "" : "s"}`
}

export const hostCommand = defineCommand({
  meta: {
    name: "host",
    description: "Start the Pond hosted control plane",
  },
  args: {
    port: {
      type: "string",
      default: "8787",
    },
    host: {
      type: "string",
      description: "Interface to bind (default 127.0.0.1)",
      default: "127.0.0.1",
    },
    "public-host": {
      type: "string",
      description: "Hostname used in returned deploy URLs (default localhost)",
      default: "localhost",
    },
    "public-base-url": {
      type: "string",
      description:
        "Full external base URL incl. scheme (e.g. https://pond.example.com). When set, deploy URLs use this " +
        "scheme/host/port instead of http://<public-host>:<port>. Use behind a TLS-terminating proxy.",
      default: "",
    },
    "abuse-email": {
      type: "string",
      description: "Contact email shown on the abuse / security pages (e.g. abuse@example.com)",
      default: "",
    },
    "data-dir": {
      type: "string",
      default: ".pond-host",
    },
    "anonymous-deploys": {
      type: "boolean",
      description: "Allow unauthenticated POST /api/deploys (Lakebed-style)",
      default: true,
    },
    "anonymous-grace": {
      type: "string",
      description: "How long before an unclaimed deploy's worker is terminated (e.g. 1h, 30m, 60s)",
      default: "1h",
    },
    "anonymous-retention": {
      type: "string",
      description: "How long before a terminated unclaimed deploy is deleted from disk",
      default: "7d",
    },
    "anonymous-rate-per-hour": {
      type: "string",
      description: "Max anonymous POST /api/deploys per IP per rolling hour",
      default: "5",
    },
    "trust-proxy": {
      type: "boolean",
      description: "Read client IP from x-forwarded-for (also POND_TRUST_PROXY_HEADERS=1)",
      default: false,
    },
  },
  async run({ args }) {
    const port = parseInt(typeof args.port === "string" ? args.port : "8787", 10)
    const hostname = typeof args.host === "string" && args.host ? args.host : "127.0.0.1"
    const publicHost =
      typeof args["public-host"] === "string" && args["public-host"] ? args["public-host"] : "localhost"
    const publicBaseUrlRaw =
      process.env.POND_PUBLIC_BASE_URL ?? (typeof args["public-base-url"] === "string" ? args["public-base-url"] : "")
    let publicBaseUrl: URL | null = null
    if (publicBaseUrlRaw) {
      try {
        publicBaseUrl = new URL(publicBaseUrlRaw.replace(/\/$/, ""))
      } catch {
        console.error(`[pond host] invalid --public-base-url: ${publicBaseUrlRaw}`)
        process.exit(1)
      }
    }
    const abuseEmail =
      process.env.POND_ABUSE_EMAIL ?? (typeof args["abuse-email"] === "string" ? args["abuse-email"] : "") ?? ""
    const dataDir = path.resolve(process.cwd(), typeof args["data-dir"] === "string" ? args["data-dir"] : ".pond-host")
    const deploysDir = path.join(dataDir, "deploys")
    const tokenFile = path.join(dataDir, "host-token")
    const apiUrl = `http://${hostname}:${port}`
    const runningChildren = new Map<string, { child: ChildProcess; port: number }>()
    const workerPath = path.resolve(import.meta.dirname, "../host/deploy-worker.js")
    const pondSrcDir = path.resolve(import.meta.dirname, "..")
    const pondNodeModulesDir = path.resolve(import.meta.dirname, "../../node_modules")

    const anonymousEnabled = args["anonymous-deploys"] !== false
    const graceStr =
      process.env.POND_ANONYMOUS_CLEANUP_GRACE ??
      (typeof args["anonymous-grace"] === "string" ? args["anonymous-grace"] : "1h")
    const retentionStr =
      process.env.POND_ANONYMOUS_CLEANUP_RETENTION ??
      (typeof args["anonymous-retention"] === "string" ? args["anonymous-retention"] : "7d")
    const anonymousGraceMs = parseDuration(graceStr)
    const anonymousRetentionMs = parseDuration(retentionStr)
    const anonymousRateLimit = parseInt(
      typeof args["anonymous-rate-per-hour"] === "string" ? args["anonymous-rate-per-hour"] : "5",
      10,
    )
    const trustProxy = process.env.POND_TRUST_PROXY_HEADERS === "1" || args["trust-proxy"] === true

    const nodeMajor = parseInt((process.versions.node ?? "0").split(".")[0], 10)
    const sandboxAvailable = nodeMajor >= 22 && fs.existsSync(pondSrcDir) && fs.existsSync(pondNodeModulesDir)
    if (!sandboxAvailable && anonymousEnabled) {
      console.log(
        `[pond host] Node ${process.versions.node} — permission model disabled. Upgrade to Node 22+ for anonymous deploy sandboxing.`,
      )
    }

    fs.mkdirSync(deploysDir, { recursive: true })
    const controlDb: ControlDb = openControlDb(dataDir)

    const ANON_DEPLOY_RATE_SCOPE = "anon_deploy_per_ip"
    const ANON_DEPLOY_RATE_WINDOW_MS = 60 * 60 * 1000
    function rateAllow(ip: string): boolean {
      return controlDb.rateAllow(ANON_DEPLOY_RATE_SCOPE, ip, ANON_DEPLOY_RATE_WINDOW_MS, anonymousRateLimit)
    }

    let hostToken = process.env.POND_HOST_TOKEN ?? ""
    if (!hostToken) {
      if (fs.existsSync(tokenFile)) {
        hostToken = fs.readFileSync(tokenFile, "utf-8").trim()
      } else {
        hostToken = randomBytes(32).toString("hex")
        fs.writeFileSync(tokenFile, hostToken, { mode: 0o600 })
      }
    }

    function urlFor(deployId: string): string {
      if (publicBaseUrl) {
        const portPart = publicBaseUrl.port ? `:${publicBaseUrl.port}` : ""
        return `${publicBaseUrl.protocol}//${deployId}.${publicBaseUrl.hostname}${portPart}`
      }
      return `http://${deployId}.${publicHost}:${port}`
    }

    function urlForCustomDomain(subdomain: string): string {
      if (publicBaseUrl) {
        const portPart = publicBaseUrl.port ? `:${publicBaseUrl.port}` : ""
        return `${publicBaseUrl.protocol}//${subdomain}.${publicBaseUrl.hostname}${portPart}`
      }
      return `http://${subdomain}.${publicHost}:${port}`
    }

    // The external hostname (no scheme/port). Used to detect "bare-domain"
    // requests (the landing / abuse / security pages) vs subdomain requests
    // (proxy to a deploy).
    const externalHost = (publicBaseUrl?.hostname ?? publicHost).toLowerCase()

    function deployDirFor(deployId: string) {
      return path.join(deploysDir, deployId)
    }

    function metaFileFor(deployId: string) {
      return path.join(deployDirFor(deployId), "deploy.json")
    }

    function envFileFor(deployId: string) {
      return path.join(deployDirFor(deployId), ".env.pond.server")
    }

    function readRecord(deployId: string): HostedDeployRecord | null {
      if (!/^[a-f0-9]+$/i.test(deployId)) return null
      const file = metaFileFor(deployId)
      if (!fs.existsSync(file)) return null
      return JSON.parse(fs.readFileSync(file, "utf-8")) as HostedDeployRecord
    }

    function writeRecord(record: HostedDeployRecord) {
      const dir = deployDirFor(record.deployId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(metaFileFor(record.deployId), JSON.stringify(record, null, 2))
    }

    function readEnv(deployId: string): Record<string, string> {
      const file = envFileFor(deployId)
      if (!fs.existsSync(file)) return {}
      return parseEnvText(fs.readFileSync(file, "utf-8"))
    }

    function writeEnv(deployId: string, entries: Record<string, string>) {
      const file = envFileFor(deployId)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, serializeEnv(entries), { mode: 0o600 })
    }

    function scopedEnvFor(_record: HostedDeployRecord): NodeJS.ProcessEnv {
      return {
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        HOME: process.env.HOME ?? "",
      }
    }

    async function stopDeploy(deployId: string) {
      const entry = runningChildren.get(deployId)
      if (!entry) return
      const { child } = entry
      runningChildren.delete(deployId)
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      try {
        child.send({ type: "shutdown" })
      } catch {
        child.kill("SIGKILL")
        return
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, 5000)
      timer.unref()
      await exited
      clearTimeout(timer)
    }

    async function forkDeploy(
      record: HostedDeployRecord,
      opts: { restrictNetwork?: boolean; useSandbox?: boolean } = {},
    ): Promise<void> {
      const dir = deployDirFor(record.deployId)
      const bundlePath = path.join(dir, "deploy-bundle.mjs")
      const clientPath = path.join(dir, "client.html")
      if (!fs.existsSync(bundlePath)) return
      await stopDeploy(record.deployId)

      // Resolve symlinks: the permission model checks REAL paths (macOS /tmp →
      // /private/tmp), and the worker uses cwd to compute its data.db location,
      // so cwd / bundlePath must be in real form when the sandbox is active.
      const realDir = opts.useSandbox && sandboxAvailable ? fs.realpathSync(dir) : dir
      const realBundlePath = opts.useSandbox && sandboxAvailable ? fs.realpathSync(bundlePath) : bundlePath
      const realClientPath = fs.existsSync(clientPath)
        ? opts.useSandbox && sandboxAvailable
          ? fs.realpathSync(clientPath)
          : clientPath
        : undefined

      const quota = controlDb.getQuota(record.deployId)
      const execArgv = [`--max-old-space-size=${quota.maxMemoryMb}`]
      if (opts.useSandbox && sandboxAvailable) {
        execArgv.push(
          "--experimental-permission",
          `--allow-fs-read=${realDir}`,
          `--allow-fs-read=${fs.realpathSync(pondSrcDir)}`,
          `--allow-fs-read=${fs.realpathSync(pondNodeModulesDir)}`,
          `--allow-fs-write=${realDir}`,
          "--allow-addons",
        )
      }
      const child = fork(workerPath, [], {
        cwd: realDir,
        env: scopedEnvFor(record),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv,
      })

      const deployId = record.deployId
      child.on("exit", (code, signal) => {
        const cur = runningChildren.get(deployId)
        if (cur && cur.child === child) {
          runningChildren.delete(deployId)
          if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
            console.error(`[pond host] deploy ${deployId} worker exited unexpectedly (code=${code}, signal=${signal})`)
          }
        }
      })

      try {
        const bootedPort = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.removeListener("message", onMessage)
            reject(new Error("Boot timed out after 10s"))
          }, 10000)
          const onMessage = (msg: any) => {
            if (msg?.type === "booted") {
              clearTimeout(timer)
              child.removeListener("message", onMessage)
              resolve(typeof msg.port === "number" ? msg.port : 0)
            } else if (msg?.type === "error") {
              clearTimeout(timer)
              child.removeListener("message", onMessage)
              reject(new Error(msg.message ?? "Worker reported error"))
            }
          }
          child.on("message", onMessage)
          child.once("exit", (code, signal) => {
            clearTimeout(timer)
            child.removeListener("message", onMessage)
            reject(new Error(`Worker exited before boot (code=${code}, signal=${signal})`))
          })
          child.send({
            type: "boot",
            options: {
              bundlePath: realBundlePath,
              clientPath: realClientPath,
              cwd: realDir,
              port: 0,
              hostname: "127.0.0.1",
              inspectSecret: record.claimToken,
              publicInspect: record.publicInspect,
              restrictNetwork: Boolean(opts.restrictNetwork),
            },
          })
        })
        runningChildren.set(deployId, { child, port: bootedPort })
        record.appPort = bootedPort
        record.url = urlFor(deployId)
        if (record.bootError) {
          delete record.bootError
        }
        writeRecord(record)
      } catch (err: any) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        record.bootError = err?.message ?? String(err)
        writeRecord(record)
        throw err
      }
    }

    for (const entry of fs.readdirSync(deploysDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const record = readRecord(entry.name)
      if (!record) continue
      const anon = controlDb.findAnonymous(record.deployId)
      if (anon && anon.terminated === 1) continue
      const isAnonUnclaimed = anon !== null
      try {
        await forkDeploy(record, {
          useSandbox: isAnonUnclaimed,
          restrictNetwork: isAnonUnclaimed,
        })
      } catch (err) {
        console.error(`[pond host] boot failed for ${record.deployId}:`, err)
      }
    }

    function runSweep() {
      const now = new Date().toISOString()
      for (const id of controlDb.listForTermination(now)) {
        try {
          stopDeploy(id)
          controlDb.markTerminated(id)
          console.log(`[pond host] anonymous deploy ${id} terminated (grace passed)`)
        } catch (e) {
          console.error(`sweep terminate ${id}:`, e)
        }
      }
      for (const id of controlDb.listForDeletion(now)) {
        try {
          stopDeploy(id)
          fs.rmSync(deployDirFor(id), { recursive: true, force: true })
          controlDb.deleteAnonymous(id)
          controlDb.deleteQuota(id)
          console.log(`[pond host] anonymous deploy ${id} deleted (retention passed)`)
        } catch (e) {
          console.error(`sweep delete ${id}:`, e)
        }
      }
      try {
        controlDb.pruneRateLimits(ANON_DEPLOY_RATE_WINDOW_MS)
      } catch (e) {
        console.error("sweep prune rate_limits:", e)
      }
    }
    runSweep()
    const sweepTimer = setInterval(runSweep, 60_000)
    sweepTimer.unref()

    const app = new Hono()
    app.use("*", async (c, next) => {
      const origin = c.req.header("origin")
      const hostHdr = (c.req.header("host") ?? "").toLowerCase()
      let allow = false
      let originHost = ""
      if (origin) {
        try {
          originHost = new URL(origin).host.toLowerCase()
          if (originHost === hostHdr) allow = true
        } catch {
          // ignore
        }
      }
      const headers: Record<string, string> = {}
      if (allow && origin) {
        headers["access-control-allow-origin"] = origin
        headers["vary"] = "Origin"
        headers["access-control-allow-credentials"] = "true"
        headers["access-control-allow-headers"] = "content-type, authorization, x-pond-claim-token"
        headers["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS"
      }
      if (c.req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers })
      }
      await next()
      for (const [k, v] of Object.entries(headers)) {
        c.res.headers.set(k, v)
      }
    })

    app.get("/api/health", (c) => c.json({ ok: true }))

    function isHostToken(token: string): boolean {
      return safeEqual(token, hostToken)
    }

    function authUser(c: any): UserRow | null {
      const provided = bearer(c.req.header("authorization"))
      if (!provided) return null
      const user = controlDb.findUserByTokenHash(controlDb.hashToken(provided))
      return user
    }

    function requireUser(c: any): { user: UserRow } | Response {
      const user = authUser(c)
      if (!user) return c.json({ error: "Unauthorized" }, 401)
      return { user }
    }

    function requireAdmin(c: any): { user: UserRow | null; viaHostToken: boolean } | Response {
      const provided = bearer(c.req.header("authorization"))
      if (!provided) return c.json({ error: "Unauthorized" }, 401)
      if (isHostToken(provided)) return { user: null, viaHostToken: true }
      const user = controlDb.findUserByTokenHash(controlDb.hashToken(provided))
      if (!user || user.isAdmin !== 1) return c.json({ error: "Forbidden" }, 403)
      return { user, viaHostToken: false }
    }

    function clientIp(c: any): string {
      if (trustProxy) {
        const xff = c.req.header("x-forwarded-for")
        if (xff) {
          const first = xff.split(",")[0]?.trim()
          if (first) return first
        }
      }
      try {
        const inc = c.env?.incoming
        const ip = inc?.socket?.remoteAddress
        if (typeof ip === "string" && ip) return ip
      } catch {
        // fall through
      }
      return "unknown"
    }

    function actorFor(user: UserRow | null, viaHostToken: boolean, anonymous = false): string {
      if (viaHostToken) return "__host__"
      if (anonymous) return "__anonymous__"
      return user?.id ?? "__unknown__"
    }

    function audit(
      actor: string,
      action: string,
      opts: { targetDeployId?: string; targetUserId?: string; metadata?: Record<string, unknown> } = {},
    ) {
      try {
        controlDb.appendAudit({
          actor,
          action,
          targetDeployId: opts.targetDeployId,
          targetUserId: opts.targetUserId,
          metadata: opts.metadata,
        })
      } catch (e) {
        console.error("[pond host] audit append failed:", e)
      }
    }

    function authorizeDeployMutation(
      c: any,
      record: HostedDeployRecord,
    ): { kind: "claim" } | { kind: "user"; user: UserRow } | Response {
      const claim = c.req.header("x-pond-claim-token") ?? ""
      if (claim && safeEqual(claim, record.claimToken)) {
        return { kind: "claim" }
      }
      const provided = bearer(c.req.header("authorization"))
      if (!provided) return c.json({ error: "Unauthorized" }, 401)
      if (isHostToken(provided)) {
        // host token gives admin powers
        return {
          kind: "user",
          user: { id: "__host__", username: "__host__", tokenHash: "", isAdmin: 1, createdAt: "" },
        }
      }
      const user = controlDb.findUserByTokenHash(controlDb.hashToken(provided))
      if (!user) return c.json({ error: "Unauthorized" }, 401)
      const ownerId = controlDb.getDeployOwner(record.deployId)
      if (user.isAdmin !== 1 && ownerId !== user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      return { kind: "user", user }
    }

    // ---- USERS ----

    app.post("/api/users", async (c) => {
      // First user bootstrap requires the host token; subsequent users require admin (host token or admin user).
      const provided = bearer(c.req.header("authorization"))
      if (!provided) return c.json({ error: "Unauthorized" }, 401)
      const hasAny = controlDb.hasAnyUser()
      if (!hasAny) {
        if (!isHostToken(provided)) return c.json({ error: "Unauthorized" }, 401)
      } else {
        if (!isHostToken(provided)) {
          const u = controlDb.findUserByTokenHash(controlDb.hashToken(provided))
          if (!u || u.isAdmin !== 1) return c.json({ error: "Forbidden" }, 403)
        }
      }
      const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; isAdmin?: unknown }
      if (typeof body.username !== "string" || !/^[a-z0-9_-]{1,32}$/i.test(body.username)) {
        return c.json({ error: "username must match /^[a-z0-9_-]{1,32}$/i" }, 400)
      }
      if (controlDb.findUserByUsername(body.username)) {
        return c.json({ error: "username taken" }, 409)
      }
      // First user is forced admin; otherwise honour isAdmin flag (default false).
      const isAdmin = !hasAny ? true : Boolean(body.isAdmin)
      const { user, token } = controlDb.createUser(body.username, isAdmin)
      const viaHostToken = isHostToken(provided)
      const actorUser = viaHostToken ? null : controlDb.findUserByTokenHash(controlDb.hashToken(provided))
      audit(actorFor(actorUser, viaHostToken), "user.create", {
        targetUserId: user.id,
        metadata: { username: user.username, isAdmin, bootstrap: !hasAny },
      })
      return c.json({ userId: user.id, username: user.username, isAdmin: user.isAdmin === 1, token }, 201)
    })

    app.get("/api/users/me", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      return c.json({ userId: r.user.id, username: r.user.username, isAdmin: r.user.isAdmin === 1 })
    })

    app.post("/api/users/me/rotate-token", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const token = controlDb.rotateUserToken(r.user.id)
      audit(actorFor(r.user, false), "user.rotate_token", { targetUserId: r.user.id })
      return c.json({ token })
    })

    // ---- AUDIT LOG ----

    app.get("/api/audit", (c) => {
      const r = requireAdmin(c)
      if (r instanceof Response) return r
      const limitRaw = c.req.query("limit")
      const sinceTs = c.req.query("sinceTs")
      const limit = limitRaw ? parseInt(limitRaw, 10) : 100
      const rows = controlDb.listAudit({
        limit: Number.isFinite(limit) ? limit : 100,
        sinceTs: typeof sinceTs === "string" && sinceTs.length > 0 ? sinceTs : undefined,
      })
      const entries = rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        actor: row.actor,
        action: row.action,
        targetDeployId: row.targetDeployId,
        targetUserId: row.targetUserId,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
      }))
      return c.json({ entries })
    })

    // ---- DEPLOYS ----

    app.get("/api/deploys", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const ids =
        r.user.isAdmin === 1
          ? fs
              .readdirSync(deploysDir, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
          : controlDb.listDeployIdsForUser(r.user.id)
      const records = ids
        .map((id) => readRecord(id))
        .filter((rec): rec is HostedDeployRecord => rec !== null)
        .map((rec) => {
          const anon = controlDb.findAnonymous(rec.deployId)
          return {
            deployId: rec.deployId,
            url: rec.url,
            apiUrl: rec.apiUrl,
            publicInspect: rec.publicInspect,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
            claimedAt: rec.claimedAt,
            ownerId: controlDb.getDeployOwner(rec.deployId),
            anonymous: anon !== null,
            terminatesAt: anon?.terminatesAt,
            expiresAt: anon?.expiresAt,
            terminated: anon?.terminated === 1,
          }
        })
      return c.json({ deploys: records })
    })

    app.post(
      "/api/deploys",
      bodyLimit({ maxSize: MAX_BUNDLE_BYTES, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
      async (c) => {
        const providedAuth = bearer(c.req.header("authorization"))
        let user: UserRow | null = null
        if (providedAuth) {
          user = controlDb.findUserByTokenHash(controlDb.hashToken(providedAuth))
          if (!user) return c.json({ error: "Unauthorized" }, 401)
        }
        const isAnonymous = user === null

        if (isAnonymous && !anonymousEnabled) {
          return c.json({ error: "Anonymous deploys disabled" }, 401)
        }
        if (isAnonymous) {
          const ip = clientIp(c)
          if (!rateAllow(ip)) {
            return new Response(JSON.stringify({ error: "Rate limit exceeded for anonymous deploys" }), {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "3600" },
            })
          }
        }
        const quotaTemplate = isAnonymous ? ANONYMOUS_QUOTA : DEFAULT_QUOTA

        const body = (await c.req.json().catch(() => null)) as {
          sourceFiles?: unknown
          publicInspect?: unknown
        } | null
        if (!body) return c.json({ error: "Invalid JSON body" }, 400)
        const validated = validateSourceFiles(body.sourceFiles)
        if (!validated.ok) return c.json({ error: validated.error }, 400)
        const deployId = randomBytes(8).toString("hex")
        const claimToken = randomBytes(32).toString("hex")
        const dir = deployDirFor(deployId)
        fs.mkdirSync(dir, { recursive: true })
        writeSourceTree(dir, validated.files)
        let buildResult: { bundleBytes: number; bundleHash: string }
        try {
          buildResult = await buildDeployFromSource(dir)
        } catch (err: any) {
          fs.rmSync(dir, { recursive: true, force: true })
          return c.json({ error: `Build failed: ${err?.message ?? err}` }, 400)
        }
        if (buildResult.bundleBytes > quotaTemplate.maxBundleBytes) {
          fs.rmSync(dir, { recursive: true, force: true })
          return c.json(
            {
              error: `Bundle exceeds ${isAnonymous ? "anonymous" : "default"} per-deploy quota (${quotaTemplate.maxBundleBytes} bytes)`,
            },
            413,
          )
        }
        const sizeAfter = dirSize(dir)
        if (sizeAfter > quotaTemplate.maxDiskBytes) {
          fs.rmSync(dir, { recursive: true, force: true })
          return c.json({ error: `Disk usage ${sizeAfter} exceeds quota ${quotaTemplate.maxDiskBytes}` }, 413)
        }
        const record: HostedDeployRecord = {
          deployId,
          claimToken,
          appPort: 0,
          url: urlFor(deployId),
          apiUrl,
          publicInspect: Boolean(body.publicInspect),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        writeRecord(record)
        let extra: { terminatesAt?: string; expiresAt?: string } = {}
        if (isAnonymous) {
          controlDb.setQuota(deployId, ANONYMOUS_QUOTA)
          const { terminatesAt, expiresAt } = controlDb.createAnonymous(
            deployId,
            claimToken,
            anonymousGraceMs,
            anonymousRetentionMs,
          )
          extra = { terminatesAt, expiresAt }
        } else {
          controlDb.setDeployOwner(deployId, user!.id)
        }
        try {
          await forkDeploy(record, {
            useSandbox: isAnonymous,
            restrictNetwork: isAnonymous,
          })
        } catch (err: any) {
          try {
            fs.rmSync(dir, { recursive: true, force: true })
          } catch {}
          if (isAnonymous) {
            controlDb.deleteAnonymous(deployId)
          } else {
            controlDb.deleteDeployOwner(deployId)
          }
          controlDb.deleteQuota(deployId)
          audit(actorFor(user, false, isAnonymous), "deploy.create_failed", {
            targetDeployId: deployId,
            metadata: {
              anonymous: isAnonymous,
              bundleBytes: buildResult.bundleBytes,
              error: String(err?.message ?? err),
            },
          })
          return c.json({ error: `Boot failed: ${err?.message ?? err}`, deployId }, 500)
        }
        audit(actorFor(user, false, isAnonymous), "deploy.create", {
          targetDeployId: deployId,
          targetUserId: user?.id,
          metadata: { anonymous: isAnonymous, bundleBytes: buildResult.bundleBytes },
        })
        return c.json(
          { ...record, ...extra, bundleHash: buildResult.bundleHash, bundleBytes: buildResult.bundleBytes },
          201,
        )
      },
    )

    app.put(
      "/api/deploys/:deployId",
      bodyLimit({ maxSize: MAX_BUNDLE_BYTES, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
      async (c) => {
        const deployId = c.req.param("deployId")
        const record = readRecord(deployId)
        if (!record) return c.json({ error: "Not found" }, 404)
        if (controlDb.findAnonymous(deployId)) {
          return c.json({ error: "Anonymous deploys cannot be updated — claim first" }, 403)
        }
        const auth = authorizeDeployMutation(c, record)
        if (auth instanceof Response) return auth
        const body = (await c.req.json().catch(() => null)) as {
          sourceFiles?: unknown
          publicInspect?: unknown
          envText?: unknown
        } | null
        if (!body) return c.json({ error: "Invalid JSON body" }, 400)
        const validated = validateSourceFiles(body.sourceFiles)
        if (!validated.ok) return c.json({ error: validated.error }, 400)
        const quota = controlDb.getQuota(deployId)
        const dir = deployDirFor(deployId)
        writeSourceTree(dir, validated.files)
        let buildResult: { bundleBytes: number; bundleHash: string }
        try {
          buildResult = await buildDeployFromSource(dir)
        } catch (err: any) {
          return c.json({ error: `Build failed: ${err?.message ?? err}` }, 400)
        }
        if (buildResult.bundleBytes > quota.maxBundleBytes) {
          return c.json({ error: `Bundle exceeds per-deploy quota (${quota.maxBundleBytes} bytes)` }, 413)
        }
        if (typeof body.envText === "string") {
          const v = validateEnvText(body.envText)
          if (!v.ok) return c.json({ error: v.error }, 413)
          fs.writeFileSync(path.join(dir, ".env.pond.server"), body.envText, { mode: 0o600 })
        }
        const sizeAfter = dirSize(dir)
        if (sizeAfter > quota.maxDiskBytes) {
          return c.json({ error: `Disk usage ${sizeAfter} exceeds quota ${quota.maxDiskBytes}` }, 413)
        }
        record.publicInspect = Boolean(body.publicInspect)
        record.updatedAt = new Date().toISOString()
        writeRecord(record)
        try {
          await forkDeploy(record)
        } catch (err: any) {
          return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
        }
        const actor = auth.kind === "claim" ? "__claim_token__" : actorFor(auth.user, false)
        audit(actor, "deploy.update", {
          targetDeployId: deployId,
          metadata: { bundleBytes: buildResult.bundleBytes, envChanged: typeof body.envText === "string" },
        })
        return c.json({ ...record, bundleHash: buildResult.bundleHash, bundleBytes: buildResult.bundleBytes })
      },
    )

    app.post("/api/deploys/:deployId/claim", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const body = (await c.req.json().catch(() => ({}))) as {
        claimToken?: unknown
        signup?: unknown
        envText?: unknown
      }
      if (typeof body.claimToken !== "string") {
        return c.json({ error: "claimToken required" }, 400)
      }
      const anon = controlDb.findAnonymous(deployId)
      const tokenMatchesRecord = safeEqual(body.claimToken, record.claimToken)
      const tokenMatchesAnon = anon ? controlDb.verifyAnonymousClaim(deployId, body.claimToken) : false
      if (!tokenMatchesRecord && !tokenMatchesAnon) {
        return c.json({ error: "Forbidden" }, 403)
      }

      // Resolve user
      let user: UserRow | null = null
      let createdCredential: { username: string; token: string } | null = null

      const signup = body.signup as { username?: unknown } | undefined
      const bearerToken = bearer(c.req.header("authorization"))

      if (signup && typeof signup.username === "string") {
        if (!anon) {
          return c.json({ error: "signup only allowed for unclaimed anonymous deploys" }, 400)
        }
        const baseName = signup.username
        if (!/^[a-z0-9_-]{1,29}$/i.test(baseName)) {
          return c.json({ error: "username must match /^[a-z0-9_-]{1,29}$/i" }, 400)
        }
        // Try base, then base-2 ... base-99.
        let chosen: string | null = null
        if (!controlDb.findUserByUsername(baseName)) {
          chosen = baseName
        } else {
          for (let n = 2; n <= 99; n++) {
            const candidate = `${baseName}-${n}`
            if (!controlDb.findUserByUsername(candidate)) {
              chosen = candidate
              break
            }
          }
        }
        if (!chosen) {
          return c.json({ error: "username taken (tried -2..-99)" }, 409)
        }
        const isFirstUser = !controlDb.hasAnyUser()
        const created = controlDb.createUser(chosen, isFirstUser)
        user = created.user
        createdCredential = { username: created.user.username, token: created.token }
      } else if (bearerToken) {
        user = controlDb.findUserByTokenHash(controlDb.hashToken(bearerToken))
        if (!user) return c.json({ error: "Unauthorized" }, 401)
      } else {
        return c.json({ error: "Provide signup or Authorization" }, 400)
      }

      if (anon) {
        controlDb.promoteAnonymous(deployId, user.id)
      } else {
        // Cross-machine ownership move: set owner if not already, or replace.
        controlDb.setDeployOwner(deployId, user.id)
      }

      if (typeof body.envText === "string") {
        const v = validateEnvText(body.envText)
        if (!v.ok) return c.json({ error: v.error }, 413)
        fs.writeFileSync(path.join(deployDirFor(deployId), ".env.pond.server"), body.envText, { mode: 0o600 })
      }
      record.claimedAt = record.claimedAt ?? new Date().toISOString()
      record.updatedAt = new Date().toISOString()
      writeRecord(record)
      try {
        await forkDeploy(record)
      } catch (err: any) {
        return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
      }
      audit(actorFor(user, false), "deploy.claim", {
        targetDeployId: deployId,
        targetUserId: user.id,
        metadata: {
          fromAnonymous: anon !== null,
          signedUp: createdCredential !== null,
        },
      })
      const resp: Record<string, unknown> = { ...record }
      if (createdCredential) resp.user = createdCredential
      return c.json(resp)
    })

    app.post("/api/deploys/:deployId/rotate-claim-token", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const r = requireUser(c)
      if (r instanceof Response) return r
      const ownerId = controlDb.getDeployOwner(deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      const newToken = randomBytes(32).toString("hex")
      record.claimToken = newToken
      record.updatedAt = new Date().toISOString()
      writeRecord(record)
      try {
        await forkDeploy(record)
      } catch (err: any) {
        return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
      }
      audit(actorFor(r.user, false), "deploy.rotate_claim_token", { targetDeployId: deployId })
      return c.json({ deployId, claimToken: newToken })
    })

    app.delete("/api/deploys/:deployId", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const auth = authorizeDeployMutation(c, record)
      if (auth instanceof Response) return auth
      await stopDeploy(deployId)
      fs.rmSync(deployDirFor(deployId), { recursive: true, force: true })
      controlDb.deleteDeployOwner(deployId)
      controlDb.deleteAnonymous(deployId)
      controlDb.deleteQuota(deployId)
      controlDb.removeDomainsForDeploy(deployId)
      const actor = auth.kind === "claim" ? "__claim_token__" : actorFor(auth.user, false)
      audit(actor, "deploy.delete", { targetDeployId: deployId })
      return c.json({ ok: true })
    })

    app.put("/api/deploys/:deployId/quota", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const r = requireAdmin(c)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => null)) as {
        maxBundleBytes?: unknown
        maxDiskBytes?: unknown
        maxMemoryMb?: unknown
      } | null
      if (!body) return c.json({ error: "Invalid JSON body" }, 400)
      if (body.maxBundleBytes === undefined && body.maxDiskBytes === undefined && body.maxMemoryMb === undefined) {
        return c.json({ error: "At least one of maxBundleBytes/maxDiskBytes/maxMemoryMb required" }, 400)
      }
      const patch: { maxBundleBytes?: number; maxDiskBytes?: number; maxMemoryMb?: number } = {}
      if (body.maxBundleBytes !== undefined) {
        if (typeof body.maxBundleBytes !== "number" || body.maxBundleBytes <= 0) {
          return c.json({ error: "maxBundleBytes must be positive number" }, 400)
        }
        patch.maxBundleBytes = body.maxBundleBytes
      }
      if (body.maxDiskBytes !== undefined) {
        if (typeof body.maxDiskBytes !== "number" || body.maxDiskBytes <= 0) {
          return c.json({ error: "maxDiskBytes must be positive number" }, 400)
        }
        patch.maxDiskBytes = body.maxDiskBytes
      }
      if (body.maxMemoryMb !== undefined) {
        if (typeof body.maxMemoryMb !== "number" || body.maxMemoryMb <= 0) {
          return c.json({ error: "maxMemoryMb must be positive number" }, 400)
        }
        patch.maxMemoryMb = body.maxMemoryMb
      }
      const prev = controlDb.getQuota(deployId)
      const next = controlDb.setQuota(deployId, patch)
      if (next.maxMemoryMb !== prev.maxMemoryMb) {
        try {
          await forkDeploy(record)
        } catch (err: any) {
          return c.json({ error: `Re-fork failed: ${err?.message ?? err}`, quota: next }, 500)
        }
      }
      audit(actorFor(r.user, r.viaHostToken), "deploy.quota_update", {
        targetDeployId: deployId,
        metadata: { patch, prev, next },
      })
      return c.json({ quota: next })
    })

    app.get("/api/deploys/:deployId/quota", (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const r = requireUser(c)
      if (r instanceof Response) return r
      const ownerId = controlDb.getDeployOwner(deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      return c.json({ quota: controlDb.getQuota(deployId) })
    })

    // ---- ENV CRUD ----

    function requireDeployOwner(c: any, deployId: string): { record: HostedDeployRecord } | Response {
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      if (controlDb.findAnonymous(deployId)) {
        return c.json({ error: "Anonymous deploys cannot manage env — claim first" }, 403)
      }
      const r = requireUser(c)
      if (r instanceof Response) return r
      const ownerId = controlDb.getDeployOwner(deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      return { record }
    }

    app.get("/api/deploys/:deployId/env", (c) => {
      const deployId = c.req.param("deployId")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      const entries = readEnv(deployId)
      return c.json({ entries })
    })

    app.put("/api/deploys/:deployId/env", async (c) => {
      const deployId = c.req.param("deployId")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => ({}))) as { entries?: unknown }
      if (!body.entries || typeof body.entries !== "object" || Array.isArray(body.entries)) {
        return c.json({ error: "entries object required" }, 400)
      }
      const incoming = body.entries as Record<string, unknown>
      const merged = readEnv(deployId)
      for (const [k, v] of Object.entries(incoming)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          return c.json({ error: `invalid key: ${k}` }, 400)
        }
        if (typeof v !== "string") {
          return c.json({ error: `value for ${k} must be string` }, 400)
        }
        if (v.length > MAX_ENV_VALUE_CHARS) {
          return c.json({ error: `value for ${k} exceeds ${MAX_ENV_VALUE_CHARS} chars` }, 413)
        }
        merged[k] = v
      }
      if (Object.keys(merged).length > MAX_ENV_ENTRIES) {
        return c.json({ error: `merged env exceeds ${MAX_ENV_ENTRIES} entries` }, 413)
      }
      const serializedBytes = Buffer.byteLength(serializeEnv(merged), "utf8")
      if (serializedBytes > MAX_ENV_BYTES) {
        return c.json({ error: `merged env exceeds ${MAX_ENV_BYTES} bytes` }, 413)
      }
      writeEnv(deployId, merged)
      const quota = controlDb.getQuota(deployId)
      const sizeAfter = dirSize(deployDirFor(deployId))
      if (sizeAfter > quota.maxDiskBytes) {
        return c.json({ error: `Disk usage ${sizeAfter} exceeds quota ${quota.maxDiskBytes}` }, 413)
      }
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      try {
        await forkDeploy(r.record)
      } catch (err: any) {
        return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
      }
      const envActor = authUser(c)
      if (envActor) {
        audit(actorFor(envActor, false), "deploy.env_update", {
          targetDeployId: deployId,
          metadata: { keys: Object.keys(incoming) },
        })
      }
      return c.json({ entries: merged })
    })

    app.delete("/api/deploys/:deployId/env/:key", async (c) => {
      const deployId = c.req.param("deployId")
      const key = c.req.param("key")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      const entries = readEnv(deployId)
      if (!(key in entries)) return c.json({ entries })
      delete entries[key]
      writeEnv(deployId, entries)
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      try {
        await forkDeploy(r.record)
      } catch (err: any) {
        return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
      }
      const envActor = authUser(c)
      if (envActor) {
        audit(actorFor(envActor, false), "deploy.env_delete", {
          targetDeployId: deployId,
          metadata: { key },
        })
      }
      return c.json({ entries })
    })

    // ---- SOURCE FILES (IDE) ----

    const FILE_PATH_RE = /^(?:(server|client|shared)\/[a-zA-Z0-9_./-]+|package\.json)$/
    const MAX_FILE_BYTES = 1 * 1024 * 1024

    function safeSourcePath(deployId: string, requested: string): string | null {
      if (!requested || requested.includes("\\") || requested.startsWith("/")) return null
      const segments = requested.split("/")
      if (segments.some((s) => s === ".." || s === "." || s === "")) return null
      if (!FILE_PATH_RE.test(requested)) return null
      const sourceDir = path.join(deployDirFor(deployId), "source")
      const abs = path.join(sourceDir, requested)
      // belt + suspenders: ensure resolved path is still inside sourceDir
      if (!abs.startsWith(sourceDir + path.sep) && abs !== sourceDir) return null
      return abs
    }

    function fileSubpath(c: any, deployId: string): string | null {
      const prefix = `/api/deploys/${deployId}/files/`
      const url = new URL(c.req.url)
      let decoded: string
      try {
        decoded = decodeURIComponent(url.pathname)
      } catch {
        return null
      }
      if (!decoded.startsWith(prefix)) return null
      return decoded.slice(prefix.length)
    }

    function listSourceTree(deployId: string): { path: string; size: number; mtime: string }[] {
      const sourceDir = path.join(deployDirFor(deployId), "source")
      if (!fs.existsSync(sourceDir)) return []
      const out: { path: string; size: number; mtime: string }[] = []
      const walk = (rel: string) => {
        const abs = path.join(sourceDir, rel)
        const stat = fs.statSync(abs)
        if (stat.isFile()) {
          out.push({ path: rel, size: stat.size, mtime: stat.mtime.toISOString() })
          return
        }
        if (stat.isDirectory()) {
          for (const entry of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${entry}` : entry)
        }
      }
      for (const entry of fs.readdirSync(sourceDir).sort()) walk(entry)
      return out
    }

    function authorizeFileOp(c: any, deployId: string): { record: HostedDeployRecord } | Response {
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      if (controlDb.findAnonymous(deployId)) {
        return c.json({ error: "Anonymous deploys cannot be edited — claim first" }, 403)
      }
      const auth = authorizeDeployMutation(c, record)
      if (auth instanceof Response) return auth
      return { record }
    }

    app.get("/api/deploys/:deployId/files", (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      return c.json({ files: listSourceTree(deployId) })
    })

    app.get("/api/deploys/:deployId/files/*", (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      const sub = fileSubpath(c, deployId)
      if (!sub) return c.json({ error: "Invalid path" }, 400)
      const abs = safeSourcePath(deployId, sub)
      if (!abs) return c.json({ error: "Path not allowed" }, 400)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return c.json({ error: "Not found" }, 404)
      return c.body(fs.readFileSync(abs), 200, { "content-type": "text/plain; charset=utf-8" })
    })

    app.put(
      "/api/deploys/:deployId/files/*",
      bodyLimit({ maxSize: MAX_FILE_BYTES, onError: (c) => c.json({ error: "File too large" }, 413) }),
      async (c) => {
        const deployId = c.req.param("deployId")
        const r = authorizeFileOp(c, deployId)
        if (r instanceof Response) return r
        const sub = fileSubpath(c, deployId)
        if (!sub) return c.json({ error: "Invalid path" }, 400)
        const abs = safeSourcePath(deployId, sub)
        if (!abs) return c.json({ error: "Path not allowed" }, 400)
        const body = await c.req.text()
        if (Buffer.byteLength(body, "utf-8") > MAX_FILE_BYTES) {
          return c.json({ error: `File exceeds ${MAX_FILE_BYTES} bytes` }, 413)
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, body)
        r.record.updatedAt = new Date().toISOString()
        writeRecord(r.record)
        const fileActor = authUser(c)
        audit(fileActor ? actorFor(fileActor, false) : "__claim_token__", "deploy.file_write", {
          targetDeployId: deployId,
          metadata: { path: sub, bytes: Buffer.byteLength(body, "utf-8") },
        })
        return c.json({ ok: true, path: sub, size: Buffer.byteLength(body, "utf-8") })
      },
    )

    app.delete("/api/deploys/:deployId/files/*", (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      const sub = fileSubpath(c, deployId)
      if (!sub) return c.json({ error: "Invalid path" }, 400)
      if (sub === "server/index.ts" || sub === "package.json") {
        return c.json({ error: "Cannot delete required file" }, 400)
      }
      const abs = safeSourcePath(deployId, sub)
      if (!abs) return c.json({ error: "Path not allowed" }, 400)
      if (!fs.existsSync(abs)) return c.json({ ok: true })
      fs.rmSync(abs, { force: true })
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      const fileActor = authUser(c)
      audit(fileActor ? actorFor(fileActor, false) : "__claim_token__", "deploy.file_delete", {
        targetDeployId: deployId,
        metadata: { path: sub },
      })
      return c.json({ ok: true })
    })

    app.post("/api/deploys/:deployId/build", async (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      const dir = deployDirFor(deployId)
      if (!fs.existsSync(path.join(dir, "source", "server", "index.ts"))) {
        return c.json({ ok: false, errors: [{ text: "source/server/index.ts missing on host" }] }, 200)
      }
      const start = Date.now()
      let result: { bundleBytes: number; bundleHash: string }
      try {
        result = await buildDeployFromSource(dir)
      } catch (err: any) {
        // esbuild throws a BuildFailure with .errors[] on compile error
        const messages: { file?: string; line?: number; column?: number; text: string }[] = []
        const raw = Array.isArray(err?.errors) ? err.errors : null
        if (raw) {
          for (const m of raw) {
            messages.push({
              file: m?.location?.file,
              line: m?.location?.line,
              column: m?.location?.column,
              text: String(m?.text ?? "unknown error"),
            })
          }
        } else {
          messages.push({ text: String(err?.message ?? err) })
        }
        return c.json({ ok: false, errors: messages, durationMs: Date.now() - start }, 200)
      }
      const quota = controlDb.getQuota(deployId)
      if (result.bundleBytes > quota.maxBundleBytes) {
        return c.json(
          { ok: false, errors: [{ text: `Bundle exceeds per-deploy quota (${quota.maxBundleBytes} bytes)` }] },
          200,
        )
      }
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      try {
        await forkDeploy(r.record)
      } catch (err: any) {
        return c.json({ ok: false, errors: [{ text: `Boot failed: ${err?.message ?? err}` }] }, 200)
      }
      const buildActor = authUser(c)
      audit(buildActor ? actorFor(buildActor, false) : "__claim_token__", "deploy.rebuild", {
        targetDeployId: deployId,
        metadata: { bundleBytes: result.bundleBytes, durationMs: Date.now() - start },
      })
      return c.json({
        ok: true,
        bundleBytes: result.bundleBytes,
        bundleHash: result.bundleHash,
        durationMs: Date.now() - start,
      })
    })

    app.post("/api/deploys/:deployId/files/move", async (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => null)) as { from?: unknown; to?: unknown } | null
      if (!body || typeof body.from !== "string" || typeof body.to !== "string") {
        return c.json({ error: "from + to required" }, 400)
      }
      if (body.from === "server/index.ts" || body.from === "package.json") {
        return c.json({ error: "Cannot move required file" }, 400)
      }
      const fromAbs = safeSourcePath(deployId, body.from)
      const toAbs = safeSourcePath(deployId, body.to)
      if (!fromAbs || !toAbs) return c.json({ error: "Path not allowed" }, 400)
      if (!fs.existsSync(fromAbs)) return c.json({ error: "Source not found" }, 404)
      if (fs.existsSync(toAbs)) return c.json({ error: "Destination exists" }, 409)
      fs.mkdirSync(path.dirname(toAbs), { recursive: true })
      fs.renameSync(fromAbs, toAbs)
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      const fileActor = authUser(c)
      audit(fileActor ? actorFor(fileActor, false) : "__claim_token__", "deploy.file_move", {
        targetDeployId: deployId,
        metadata: { from: body.from, to: body.to },
      })
      return c.json({ ok: true })
    })

    // ---- CUSTOM DOMAINS ----

    app.get("/api/domains", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const rows =
        r.user.isAdmin === 1
          ? fs
              .readdirSync(deploysDir, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .flatMap((e) =>
                controlDb
                  .listDomainsForDeploy(e.name)
                  .map((d) => ({ subdomain: d.subdomain, deployId: e.name, createdAt: d.createdAt })),
              )
          : controlDb.listDomainsForUser(r.user.id)
      return c.json({ domains: rows })
    })

    app.post("/api/domains", async (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => ({}))) as { subdomain?: unknown; deployId?: unknown }
      if (typeof body.subdomain !== "string" || typeof body.deployId !== "string") {
        return c.json({ error: "subdomain and deployId required" }, 400)
      }
      const sub = body.subdomain
      if (!SUBDOMAIN_LABEL_RE.test(sub) || sub.length > 63) {
        return c.json(
          { error: "invalid subdomain (DNS label rules: a-z, 0-9, hyphens; max 63; no leading/trailing hyphen)" },
          400,
        )
      }
      if (RESERVED_SUBDOMAINS.has(sub)) {
        return c.json({ error: `subdomain "${sub}" is reserved` }, 400)
      }
      if (HEX_DEPLOY_ID_RE.test(sub)) {
        return c.json({ error: "subdomain may not be a 16-char hex string (collides with deployId routing)" }, 400)
      }
      const record = readRecord(body.deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const ownerId = controlDb.getDeployOwner(body.deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      if (r.user.isAdmin !== 1 && controlDb.countDomainsForUser(r.user.id) >= MAX_DOMAINS_PER_USER) {
        return c.json({ error: `domain limit reached (${MAX_DOMAINS_PER_USER} per user)` }, 429)
      }
      try {
        controlDb.addDomain(sub, body.deployId)
      } catch (err: any) {
        if (String(err?.code ?? "").includes("SQLITE_CONSTRAINT")) {
          return c.json({ error: "subdomain already taken" }, 409)
        }
        throw err
      }
      const row = controlDb.findDomain(sub)
      audit(actorFor(r.user, false), "domain.add", {
        targetDeployId: body.deployId,
        metadata: { subdomain: sub },
      })
      return c.json(
        {
          subdomain: sub,
          deployId: body.deployId,
          createdAt: row?.createdAt,
          url: urlForCustomDomain(sub),
        },
        201,
      )
    })

    app.delete("/api/domains/:subdomain", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const sub = c.req.param("subdomain").toLowerCase()
      const row = controlDb.findDomain(sub)
      if (!row) return c.json({ error: "Not found" }, 404)
      const ownerId = controlDb.getDeployOwner(row.deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      controlDb.removeDomain(sub)
      audit(actorFor(r.user, false), "domain.remove", {
        targetDeployId: row.deployId,
        metadata: { subdomain: sub },
      })
      return c.json({ ok: true })
    })

    const HOP_BY_HOP = new Set([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "host",
    ])
    function deployIdFromHost(hostHeader: string | undefined): string | null {
      if (!hostHeader) return null
      const bare = hostHeader.toLowerCase().split(":")[0]
      const dot = bare.indexOf(".")
      if (dot <= 0) return null
      const sub = bare.slice(0, dot)
      if (HEX_DEPLOY_ID_RE.test(sub)) return sub
      const domain = controlDb.findDomain(sub)
      return domain?.deployId ?? null
    }

    function isBareDomainRequest(hostHeader: string | undefined): boolean {
      if (!hostHeader) return false
      const bare = hostHeader.toLowerCase().split(":")[0]
      return bare === externalHost || bare === `www.${externalHost}`
    }

    function landingHtml(): string {
      const installCmd = "npm install -g pondsh"
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pond</title>
<meta name="description" content="Agent-native full-stack TypeScript capsules." />
<style>
  :root {
    --bg: #000;
    --text: #f5f5f5;
    --muted: #aaa;
    --line: #242424;
    --code-bg: #080808;
    --code: #ededed;
    --link: #8ab4ff;
    --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html { min-height: 100%; background: var(--bg); color: var(--text); font-family: var(--sans); }
  body { min-height: 100vh; margin: 0; background: var(--bg); }
  main {
    display: flex;
    min-height: 100vh;
    width: min(720px, calc(100vw - 40px));
    margin: 0 auto;
    padding: 88px 0;
    align-items: center;
  }
  .content { width: 100%; }
  h1 {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 14px;
    margin: 0 0 18px;
    color: var(--text);
    font-size: 72px;
    line-height: 0.94;
    letter-spacing: 0;
  }
  .alpha-mark {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 0.34em;
    font-weight: 500;
    line-height: 1;
  }
  p {
    max-width: 620px;
    margin: 0;
    color: var(--muted);
    font-size: 21px;
    line-height: 1.45;
  }
  .command-button {
    display: flex;
    width: 100%;
    min-height: 64px;
    margin: 40px 0 28px;
    padding: 18px 20px;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    border: 1px solid var(--line);
    background: var(--code-bg);
    color: var(--code);
    font-family: var(--mono);
    font-size: 16px;
    line-height: 1.5;
    text-align: left;
    cursor: pointer;
  }
  .command-button:hover, .command-button:focus-visible { border-color: #4a4a4a; }
  .command-button:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
  code { font-family: inherit; }
  .copy-state {
    flex: 0 0 auto;
    color: var(--muted);
    font-family: var(--sans);
    font-size: 14px;
  }
  a {
    color: var(--link);
    font-size: 17px;
    text-decoration-thickness: 1px;
    text-underline-offset: 4px;
  }
  .links { display: flex; flex-wrap: wrap; gap: 22px; }
  .fine {
    margin-top: 28px;
    color: #5a5a5a;
    font-size: 13px;
    line-height: 1.5;
  }
  .fine a { color: #7a7a7a; font-size: 13px; }
  @media (max-width: 640px) {
    main { width: min(100vw - 28px, 720px); padding: 48px 0; align-items: flex-start; }
    p { font-size: 18px; }
    h1 { font-size: 44px; }
    .command-button { margin-top: 34px; font-size: 15px; }
  }
</style>
</head>
<body>
<main>
  <div class="content">
    <h1>pond <span class="alpha-mark">[alpha]</span></h1>
    <p>Agent-native full-stack TypeScript capsules. Deploy anonymously.</p>
    <button class="command-button" type="button" data-command="${installCmd}" aria-label="Copy ${installCmd}">
      <code>${installCmd}</code>
      <span class="copy-state" aria-live="polite">Copy</span>
    </button>
    <div class="links">
      <a href="https://github.com/DevvGwardo/pond">Docs</a>
    </div>
    <p class="fine">
      Anonymous deploys are sandboxed and may be terminated at any time. <a href="/abuse">Abuse policy</a> · <a href="/.well-known/security.txt">Security</a>
    </p>
  </div>
</main>
<script>
  const commandButton = document.querySelector(".command-button");
  const copyState = document.querySelector(".copy-state");
  async function copyText(value) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (copied) return;
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    throw new Error("Unable to copy command.");
  }
  commandButton.addEventListener("click", async () => {
    const command = commandButton.dataset.command;
    try {
      await copyText(command);
      copyState.textContent = "Copied";
    } catch {
      copyState.textContent = "Copy failed";
    }
    window.setTimeout(() => { copyState.textContent = "Copy"; }, 1400);
  });
</script>
</body>
</html>`
    }

    function abuseHtml(): string {
      const contact = abuseEmail ? `<a href="mailto:${abuseEmail}">${abuseEmail}</a>` : "the host operator"
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Pond — Abuse Policy</title>
<style>
  body { margin: 0; background: #09090b; color: #e4e4e7; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; line-height: 1.6; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 32px; margin: 0 0 24px; }
  h2 { font-size: 18px; margin: 28px 0 8px; color: #d4d4d8; }
  a { color: #a5f3fc; }
  p, li { color: #d4d4d8; }
  ul { padding-left: 22px; }
</style>
</head>
<body>
<main>
  <h1>Abuse policy</h1>
  <p>Pond hosts arbitrary user-submitted capsules anonymously. To keep this service usable, the following are prohibited:</p>
  <ul>
    <li>Phishing, credential harvesting, or impersonation of any third party.</li>
    <li>Malware distribution, drive-by downloads, exploit kits.</li>
    <li>Cryptocurrency mining, brute force / credential stuffing, or any abuse of compute resources.</li>
    <li>Spam, scams, illegal content under the jurisdiction of the host operator.</li>
    <li>Targeted harassment or doxing.</li>
  </ul>
  <h2>Reporting abuse</h2>
  <p>Email ${contact} with the deploy URL and a description of the issue. The host operator may take down any deploy at any time without notice. There is no SLA.</p>
  <h2>Service limits</h2>
  <p>Anonymous deploys: 16 MB bundle, 128 MB disk, 128 MB memory, 1 hour grace before termination, 7 days before deletion, 5 deploys per IP per hour. Outbound network access is restricted at the JavaScript layer for anonymous deploys.</p>
  <h2>No warranty</h2>
  <p>Pond is provided as-is. The host operator makes no guarantees of availability, durability, or fitness for any purpose. Do not deploy production workloads.</p>
  <p style="margin-top:36px;"><a href="/">← back</a></p>
</main>
</body>
</html>`
    }

    function securityTxt(): string {
      const contact = abuseEmail
        ? `Contact: mailto:${abuseEmail}`
        : "Contact: (set POND_ABUSE_EMAIL to populate this field)"
      const oneYearOut = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      return `${contact}
Expires: ${oneYearOut}T00:00:00.000Z
Preferred-Languages: en
Canonical: ${publicBaseUrl ? publicBaseUrl.toString().replace(/\/$/, "") : `http://${publicHost}:${port}`}/.well-known/security.txt
`
    }

    app.all("*", async (c) => {
      // Bare-domain requests (no subdomain) — serve the marketing / policy pages.
      if (isBareDomainRequest(c.req.header("host"))) {
        const url = new URL(c.req.url)
        if (c.req.method === "GET") {
          if (url.pathname === "/" || url.pathname === "") {
            return c.html(landingHtml())
          }
          if (url.pathname === "/abuse") {
            return c.html(abuseHtml())
          }
          if (url.pathname === "/.well-known/security.txt") {
            return new Response(securityTxt(), {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })
          }
          if (url.pathname === "/robots.txt") {
            return new Response("User-agent: *\nAllow: /\n", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })
          }
          if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#09090b"/><path d="M16 6c-3 5-7 9-7 13a7 7 0 0 0 14 0c0-4-4-8-7-13z" fill="#67e8f9"/></svg>`
            return new Response(svg, {
              status: 200,
              headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
            })
          }
          const ideMatch = url.pathname.match(/^\/ide\/([a-f0-9]+)\/?$/)
          if (ideMatch) {
            const deployId = ideMatch[1]
            const record = readRecord(deployId)
            if (!record) return c.json({ error: "Unknown deploy" }, 404)
            const bootstrap = JSON.stringify({
              deployId,
              deployUrl: record.url,
              publicHost,
              controlUrl: apiUrl,
            })
            const html = ideHtml.replace("__POND_IDE__BOOTSTRAP__", `window.__POND_IDE = ${bootstrap}`)
            return c.html(html)
          }
        }
        return c.json({ error: "Not found" }, 404)
      }

      const deployId = deployIdFromHost(c.req.header("host"))
      if (!deployId) return c.json({ error: "Not found" }, 404)
      const entry = runningChildren.get(deployId)
      if (!entry) return c.json({ error: "Unknown deploy" }, 404)
      const url = new URL(c.req.url)
      const target = `http://127.0.0.1:${entry.port}${url.pathname}${url.search}`
      const headers = new Headers()
      c.req.raw.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v)
      })
      const method = c.req.method
      const hasBody = method !== "GET" && method !== "HEAD"
      const init: RequestInit & { duplex?: "half" } = { method, headers }
      if (hasBody) {
        init.body = c.req.raw.body
        init.duplex = "half"
      }
      let upstream: Response
      try {
        upstream = await fetch(target, init)
      } catch (err: any) {
        return c.json({ error: `Upstream error: ${err?.message ?? err}` }, 502)
      }
      const respHeaders = new Headers()
      upstream.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k.toLowerCase())) respHeaders.set(k, v)
      })
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
    })

    const controlServer = serve({ fetch: app.fetch, port, hostname })

    const shutdown = async () => {
      console.log("\n[pond host] shutting down")
      for (const deployId of [...runningChildren.keys()]) {
        await stopDeploy(deployId)
      }
      controlDb.close()
      controlServer.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 2000).unref()
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)

    console.log(`\n  pond host control plane running at http://${hostname}:${port}`)
    if (publicBaseUrl) {
      console.log(`  public base URL: ${publicBaseUrl.toString().replace(/\/$/, "")}`)
    }
    if (!abuseEmail) {
      console.log(`  ⚠ no --abuse-email set — security.txt / abuse page will be unhelpful for a public deploy.`)
    }
    console.log(`  host token (bootstrap / recovery): ${hostToken}`)
    console.log(`  bootstrap first admin: pond login --api ${apiUrl} --username <name>`)
    if (anonymousEnabled) {
      console.log(
        `  anonymous deploys: enabled (grace=${formatHumanDuration(anonymousGraceMs)}, retention=${formatHumanDuration(anonymousRetentionMs)}, rate=${anonymousRateLimit}/h)\n`,
      )
    } else {
      console.log("  anonymous deploys: disabled\n")
    }
    if (hostname === "0.0.0.0" || hostname === "::") {
      console.log(
        "  ⚠ bound to all interfaces — deploying a bundle here gives the caller arbitrary code execution as this user.\n",
      )
    }
  },
})
