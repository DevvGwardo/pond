import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { buildForDeploy } from "../runtime.js"
import { buildClient } from "../bundler.js"

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
    "public-inspect": {
      type: "boolean",
      description: "Allow hosted inspection endpoints without a claim token",
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
    const deployId = randomBytes(4).toString("hex")
    const { outfile, hash } = await buildForDeploy(serverFile, cwd)
    const clientPath = path.join(deployDir, "client.html")
    const clientHtml = fs.existsSync(clientFile) ? await buildClient(clientFile) : undefined
    const apiUrl = typeof args.api === "string" && args.api ? args.api.replace(/\/$/, "") : undefined

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
          2
        )
      )

      console.log("Deployed! Run `pond start` to serve, or set PORT= env var")
      return
    }

    const baseBody = {
      bundleBase64: Buffer.from(fs.readFileSync(outfile)).toString("base64"),
      clientHtmlBase64: clientHtml ? Buffer.from(clientHtml).toString("base64") : undefined,
      publicInspect: Boolean(args["public-inspect"]),
    }

    const envText =
      localRecord?.claimToken && fs.existsSync(envFile)
        ? fs.readFileSync(envFile, "utf-8")
        : undefined

    let response: Response

    if (localRecord?.apiUrl === apiUrl && localRecord.deployId && localRecord.claimToken) {
      response = await fetch(`${apiUrl}/api/deploys/${localRecord.deployId}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-pond-claim-token": localRecord.claimToken,
        },
        body: JSON.stringify({
          ...baseBody,
          envText,
        }),
      })
    } else {
      response = await fetch(`${apiUrl}/api/deploys`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(baseBody),
      })
    }

    if (!response.ok) {
      throw new Error(`Hosted deploy failed: ${response.status}`)
    }

    const remote = (await response.json()) as {
      deployId: string
      claimToken: string
      url: string
      apiUrl: string
      publicInspect: boolean
      claimedAt?: string
      updatedAt?: string
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
          port: parseInt(args.port, 10),
        },
        null,
        2
      )
    )

    if (remote.claimedAt) {
      console.log(`Hosted deploy updated at ${remote.url}`)
    } else {
      console.log(`Hosted deploy created at ${remote.url}`)
      console.log("Run `pond claim` to attach server env and mark ownership.")
    }
  },
})
