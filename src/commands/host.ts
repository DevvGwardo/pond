import { defineCommand } from "citty"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { bodyLimit } from "hono/body-limit"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { fork, type ChildProcess } from "node:child_process"
import { openControlDb, DEFAULT_QUOTA, type ControlDb, type UserRow } from "../host/control-db.js"

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
    "data-dir": {
      type: "string",
      default: ".pond-host",
    },
  },
  async run({ args }) {
    const port = parseInt(typeof args.port === "string" ? args.port : "8787", 10)
    const hostname = typeof args.host === "string" && args.host ? args.host : "127.0.0.1"
    const publicHost = typeof args["public-host"] === "string" && args["public-host"] ? args["public-host"] : "localhost"
    const dataDir = path.resolve(process.cwd(), typeof args["data-dir"] === "string" ? args["data-dir"] : ".pond-host")
    const deploysDir = path.join(dataDir, "deploys")
    const tokenFile = path.join(dataDir, "host-token")
    const apiUrl = `http://${hostname}:${port}`
    const runningChildren = new Map<string, { child: ChildProcess; port: number }>()
    const workerPath = path.resolve(import.meta.dirname, "../host/deploy-worker.js")

    function urlFor(deployId: string): string {
      return `http://${deployId}.${publicHost}:${port}`
    }

    fs.mkdirSync(deploysDir, { recursive: true })
    const controlDb: ControlDb = openControlDb(dataDir)

    let hostToken = process.env.POND_HOST_TOKEN ?? ""
    if (!hostToken) {
      if (fs.existsSync(tokenFile)) {
        hostToken = fs.readFileSync(tokenFile, "utf-8").trim()
      } else {
        hostToken = randomBytes(32).toString("hex")
        fs.writeFileSync(tokenFile, hostToken, { mode: 0o600 })
      }
    }

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

    async function forkDeploy(record: HostedDeployRecord): Promise<void> {
      const dir = deployDirFor(record.deployId)
      const bundlePath = path.join(dir, "deploy-bundle.mjs")
      const clientPath = path.join(dir, "client.html")
      if (!fs.existsSync(bundlePath)) return
      await stopDeploy(record.deployId)

      const quota = controlDb.getQuota(record.deployId)
      const child = fork(workerPath, [], {
        cwd: dir,
        env: scopedEnvFor(record),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv: [`--max-old-space-size=${quota.maxMemoryMb}`],
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
              bundlePath,
              clientPath: fs.existsSync(clientPath) ? clientPath : undefined,
              cwd: dir,
              port: 0,
              hostname: "127.0.0.1",
              inspectSecret: record.claimToken,
              publicInspect: record.publicInspect,
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
      if (record) {
        try {
          await forkDeploy(record)
        } catch (err) {
          console.error(`[pond host] boot failed for ${record.deployId}:`, err)
        }
      }
    }

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

    function authorizeDeployMutation(
      c: any,
      record: HostedDeployRecord
    ): { kind: "claim" } | { kind: "user"; user: UserRow } | Response {
      const claim = c.req.header("x-pond-claim-token") ?? ""
      if (claim && safeEqual(claim, record.claimToken)) {
        return { kind: "claim" }
      }
      const provided = bearer(c.req.header("authorization"))
      if (!provided) return c.json({ error: "Unauthorized" }, 401)
      if (isHostToken(provided)) {
        // host token gives admin powers
        return { kind: "user", user: { id: "__host__", username: "__host__", tokenHash: "", isAdmin: 1, createdAt: "" } }
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
      return c.json({ token })
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
        .map((rec) => ({
          deployId: rec.deployId,
          url: rec.url,
          apiUrl: rec.apiUrl,
          publicInspect: rec.publicInspect,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          claimedAt: rec.claimedAt,
          ownerId: controlDb.getDeployOwner(rec.deployId),
        }))
      return c.json({ deploys: records })
    })

    app.post(
      "/api/deploys",
      bodyLimit({ maxSize: MAX_BUNDLE_BYTES, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
      async (c) => {
        const r = requireUser(c)
        if (r instanceof Response) return r
        const body = (await c.req.json()) as {
          bundleBase64?: unknown
          clientHtmlBase64?: unknown
          publicInspect?: unknown
        }
        if (typeof body.bundleBase64 !== "string" || body.bundleBase64.length === 0) {
          return c.json({ error: "bundleBase64 required" }, 400)
        }
        if (body.clientHtmlBase64 !== undefined && typeof body.clientHtmlBase64 !== "string") {
          return c.json({ error: "clientHtmlBase64 must be string" }, 400)
        }
        const bundleBuf = Buffer.from(body.bundleBase64, "base64")
        if (bundleBuf.length > DEFAULT_QUOTA.maxBundleBytes) {
          return c.json({ error: `Bundle exceeds default per-deploy quota (${DEFAULT_QUOTA.maxBundleBytes} bytes)` }, 413)
        }
        const deployId = randomBytes(8).toString("hex")
        const claimToken = randomBytes(32).toString("hex")
        const dir = deployDirFor(deployId)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, "deploy-bundle.mjs"), bundleBuf)
        if (typeof body.clientHtmlBase64 === "string") {
          fs.writeFileSync(path.join(dir, "client.html"), Buffer.from(body.clientHtmlBase64, "base64"))
        }
        const sizeAfter = dirSize(dir)
        if (sizeAfter > DEFAULT_QUOTA.maxDiskBytes) {
          fs.rmSync(dir, { recursive: true, force: true })
          return c.json({ error: `Disk usage ${sizeAfter} exceeds default quota ${DEFAULT_QUOTA.maxDiskBytes}` }, 413)
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
        controlDb.setDeployOwner(deployId, r.user.id)
        try {
          await forkDeploy(record)
        } catch (err: any) {
          return c.json({ error: `Boot failed: ${err?.message ?? err}`, deployId }, 500)
        }
        return c.json(record, 201)
      }
    )

    app.put(
      "/api/deploys/:deployId",
      bodyLimit({ maxSize: MAX_BUNDLE_BYTES, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
      async (c) => {
        const deployId = c.req.param("deployId")
        const record = readRecord(deployId)
        if (!record) return c.json({ error: "Not found" }, 404)
        const auth = authorizeDeployMutation(c, record)
        if (auth instanceof Response) return auth
        const body = (await c.req.json()) as {
          bundleBase64?: unknown
          clientHtmlBase64?: unknown
          publicInspect?: unknown
          envText?: unknown
        }
        if (typeof body.bundleBase64 !== "string" || body.bundleBase64.length === 0) {
          return c.json({ error: "bundleBase64 required" }, 400)
        }
        const bundleBuf = Buffer.from(body.bundleBase64, "base64")
        const quota = controlDb.getQuota(deployId)
        if (bundleBuf.length > quota.maxBundleBytes) {
          return c.json({ error: `Bundle exceeds per-deploy quota (${quota.maxBundleBytes} bytes)` }, 413)
        }
        const dir = deployDirFor(deployId)
        fs.writeFileSync(path.join(dir, "deploy-bundle.mjs"), bundleBuf)
        if (typeof body.clientHtmlBase64 === "string") {
          fs.writeFileSync(path.join(dir, "client.html"), Buffer.from(body.clientHtmlBase64, "base64"))
        }
        if (typeof body.envText === "string") {
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
        return c.json(record)
      }
    )

    app.post("/api/deploys/:deployId/claim", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const body = (await c.req.json()) as {
        claimToken?: unknown
        envText?: unknown
      }
      if (typeof body.claimToken !== "string" || !safeEqual(body.claimToken, record.claimToken)) {
        return c.json({ error: "Forbidden" }, 403)
      }
      if (typeof body.envText === "string") {
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
      return c.json(record)
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
      controlDb.deleteQuota(deployId)
      return c.json({ ok: true })
    })

    app.put("/api/deploys/:deployId/quota", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const r = requireAdmin(c)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => ({}))) as {
        maxBundleBytes?: unknown
        maxDiskBytes?: unknown
        maxMemoryMb?: unknown
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
        merged[k] = v
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
      return c.json({ entries })
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
    const SUBDOMAIN_RE = /^[a-f0-9]{8,}$/

    function deployIdFromHost(hostHeader: string | undefined): string | null {
      if (!hostHeader) return null
      const bare = hostHeader.toLowerCase().split(":")[0]
      const dot = bare.indexOf(".")
      if (dot <= 0) return null
      const sub = bare.slice(0, dot)
      return SUBDOMAIN_RE.test(sub) ? sub : null
    }

    app.all("*", async (c) => {
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
    console.log(`  host token (bootstrap / recovery): ${hostToken}`)
    console.log(`  bootstrap first admin: pond login --api ${apiUrl} --username <name>\n`)
    if (hostname === "0.0.0.0" || hostname === "::") {
      console.log("  ⚠ bound to all interfaces — deploying a bundle here gives the caller arbitrary code execution as this user.\n")
    }
  },
})
