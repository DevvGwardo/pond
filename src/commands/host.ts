import { defineCommand } from "citty"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { cors } from "hono/cors"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { serveBundleServer } from "../start-server.js"

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
    "app-port-start": {
      type: "string",
      default: "4100",
    },
    "data-dir": {
      type: "string",
      default: ".pond-host",
    },
  },
  async run({ args }) {
    const port = parseInt(typeof args.port === "string" ? args.port : "8787", 10)
    const appPortStart = parseInt(typeof args["app-port-start"] === "string" ? args["app-port-start"] : "4100", 10)
    const dataDir = path.resolve(process.cwd(), typeof args["data-dir"] === "string" ? args["data-dir"] : ".pond-host")
    const deploysDir = path.join(dataDir, "deploys")
    const apiUrl = `http://localhost:${port}`
    const runningServers = new Map<string, { close: (callback?: (err?: Error) => void) => void }>()

    fs.mkdirSync(deploysDir, { recursive: true })

    function deployDirFor(deployId: string) {
      return path.join(deploysDir, deployId)
    }

    function metaFileFor(deployId: string) {
      return path.join(deployDirFor(deployId), "deploy.json")
    }

    function readRecord(deployId: string): HostedDeployRecord | null {
      const file = metaFileFor(deployId)
      if (!fs.existsSync(file)) return null
      return JSON.parse(fs.readFileSync(file, "utf-8")) as HostedDeployRecord
    }

    function writeRecord(record: HostedDeployRecord) {
      const dir = deployDirFor(record.deployId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(metaFileFor(record.deployId), JSON.stringify(record, null, 2))
    }

    function nextAppPort() {
      let maxPort = appPortStart - 1
      for (const entry of fs.readdirSync(deploysDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const record = readRecord(entry.name)
        if (record && record.appPort > maxPort) {
          maxPort = record.appPort
        }
      }
      return maxPort + 1
    }

    async function bootDeploy(record: HostedDeployRecord) {
      const dir = deployDirFor(record.deployId)
      const bundlePath = path.join(dir, "deploy-bundle.mjs")
      const clientPath = path.join(dir, "client.html")
      if (!fs.existsSync(bundlePath)) return
      if (runningServers.has(record.deployId)) {
        await new Promise<void>((resolve) => {
          runningServers.get(record.deployId)?.close(() => resolve())
        })
        runningServers.delete(record.deployId)
      }
      const { server } = await serveBundleServer({
        bundlePath,
        clientPath: fs.existsSync(clientPath) ? clientPath : undefined,
        cwd: dir,
        port: record.appPort,
        inspectSecret: record.claimToken,
        publicInspect: record.publicInspect,
      })
      runningServers.set(record.deployId, server)
    }

    for (const entry of fs.readdirSync(deploysDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const record = readRecord(entry.name)
      if (record) {
        await bootDeploy(record)
      }
    }

    const app = new Hono()
    app.use("*", cors())

    app.get("/api/health", (c) => c.json({ ok: true }))

    app.post("/api/deploys", async (c) => {
      const body = (await c.req.json()) as {
        bundleBase64: string
        clientHtmlBase64?: string
        publicInspect?: boolean
      }
      const deployId = randomBytes(4).toString("hex")
      const claimToken = randomBytes(16).toString("hex")
      const appPort = nextAppPort()
      const dir = deployDirFor(deployId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "deploy-bundle.mjs"), Buffer.from(body.bundleBase64, "base64"))
      if (body.clientHtmlBase64) {
        fs.writeFileSync(path.join(dir, "client.html"), Buffer.from(body.clientHtmlBase64, "base64"))
      }
      const record: HostedDeployRecord = {
        deployId,
        claimToken,
        appPort,
        url: `http://localhost:${appPort}`,
        apiUrl,
        publicInspect: Boolean(body.publicInspect),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      writeRecord(record)
      await bootDeploy(record)
      return c.json(record, 201)
    })

    app.put("/api/deploys/:deployId", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      if (c.req.header("x-pond-claim-token") !== record.claimToken) {
        return c.json({ error: "Forbidden" }, 403)
      }
      const body = (await c.req.json()) as {
        bundleBase64: string
        clientHtmlBase64?: string
        publicInspect?: boolean
        envText?: string
      }
      const dir = deployDirFor(deployId)
      fs.writeFileSync(path.join(dir, "deploy-bundle.mjs"), Buffer.from(body.bundleBase64, "base64"))
      if (body.clientHtmlBase64) {
        fs.writeFileSync(path.join(dir, "client.html"), Buffer.from(body.clientHtmlBase64, "base64"))
      }
      if (typeof body.envText === "string") {
        fs.writeFileSync(path.join(dir, ".env.pond.server"), body.envText)
      }
      record.publicInspect = Boolean(body.publicInspect)
      record.updatedAt = new Date().toISOString()
      writeRecord(record)
      await bootDeploy(record)
      return c.json(record)
    })

    app.post("/api/deploys/:deployId/claim", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const body = (await c.req.json()) as {
        claimToken: string
        envText?: string
      }
      if (body.claimToken !== record.claimToken) {
        return c.json({ error: "Forbidden" }, 403)
      }
      if (typeof body.envText === "string") {
        fs.writeFileSync(path.join(deployDirFor(deployId), ".env.pond.server"), body.envText)
      }
      record.claimedAt = record.claimedAt ?? new Date().toISOString()
      record.updatedAt = new Date().toISOString()
      writeRecord(record)
      await bootDeploy(record)
      return c.json(record)
    })

    console.log(`\n  pond host control plane running at http://localhost:${port}\n`)

    serve({ fetch: app.fetch, port })
  },
})
