import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { serveBundleServer } from "../start-server.js"

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start a deployed capsule bundle",
  },
  args: {
    port: {
      type: "string",
      description: "Port to listen on",
      default: "",
    },
  },
  async run({ args }) {
    const cwd = process.cwd()
    const deployFile = path.join(cwd, ".pond", "deploy.json")

    if (!fs.existsSync(deployFile)) {
      console.error("No .pond/deploy.json found. Run `pond deploy` first.")
      process.exit(1)
    }

    const deploy = JSON.parse(fs.readFileSync(deployFile, "utf-8")) as {
      bundlePath?: string
      clientPath?: string
      port?: number
    }

    const bundlePath = deploy.bundlePath ?? path.join(cwd, ".pond", "deploy-bundle.mjs")
    const clientPath = deploy.clientPath ?? path.join(cwd, ".pond", "client.html")
    const port =
      typeof args.port === "string" && args.port
        ? parseInt(args.port, 10)
        : parseInt(process.env.PORT ?? "", 10) || deploy.port || 3000

    if (!fs.existsSync(bundlePath)) {
      console.error("No deploy bundle found. Run `pond deploy` first.")
      process.exit(1)
    }

    await serveBundleServer({
      bundlePath,
      clientPath,
      cwd,
      port,
    })

    console.log(`\n  pond start server running at http://localhost:${port}\n`)
  },
})
