import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { buildForDeploy } from "../runtime.js"

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
  },
  async run({ args }) {
    const cwd = process.cwd()
    const serverFile = path.join(cwd, "server", "index.ts")
    const deployDir = path.join(cwd, ".pond")
    const deployId = randomBytes(4).toString("hex")
    const { outfile, hash } = await buildForDeploy(serverFile, cwd)

    fs.mkdirSync(deployDir, { recursive: true })
    fs.writeFileSync(
      path.join(deployDir, "deploy.json"),
      JSON.stringify(
        {
          deployId,
          timestamp: new Date().toISOString(),
          bundleHash: hash,
          bundlePath: outfile,
          port: parseInt(args.port, 10),
        },
        null,
        2
      )
    )

    console.log("Deployed! Run `pond start` to serve, or set PORT= env var")
  },
})
