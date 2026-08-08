import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { serveBundleServer } from "../start-server.js"
import { parsePort } from "./shared.js"

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
      apiUrl?: string
      url?: string
      deployId?: string
    }

    const bundlePath = deploy.bundlePath ?? path.join(cwd, ".pond", "deploy-bundle.mjs")
    const clientPath = deploy.clientPath ?? path.join(cwd, ".pond", "client.html")
    // --port wins; then PORT env; then the port saved in deploy.json; then 3000.
    // parsePort fails loudly on garbage instead of letting NaN into a listener.
    const port = parsePort(
      typeof args.port === "string" && args.port ? args.port : undefined,
      parsePort(process.env.PORT || undefined, typeof deploy.port === "number" ? deploy.port : 3000, "PORT"),
    )

    if (!fs.existsSync(bundlePath)) {
      if (deploy.apiUrl && deploy.url) {
        console.error(`This capsule was deployed to a hosted control plane (${deploy.apiUrl}).`)
        console.error(`It's already running at ${deploy.url}.`)
        console.error(``)
        console.error(`\`pond start\` only serves offline bundles built with \`pond deploy --local\`.`)
        console.error(`To build an offline bundle and start it locally, run:`)
        console.error(``)
        console.error(`  pond deploy --local`)
        console.error(`  pond start`)
        process.exit(1)
      }
      console.error("No deploy bundle found. Run `pond deploy --local` first to build an offline bundle.")
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
