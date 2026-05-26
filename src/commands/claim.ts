import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"

export const claimCommand = defineCommand({
  meta: {
    name: "claim",
    description: "Cross-machine claim using a deploy's claim token (rarely needed)",
  },
  async run() {
    const cwd = process.cwd()
    const deployFile = path.join(cwd, ".pond", "deploy.json")
    const envFile = path.join(cwd, ".env.pond.server")

    if (!fs.existsSync(deployFile)) {
      console.error("No .pond/deploy.json found. Run `pond deploy --api ...` first.")
      process.exit(1)
    }

    const deploy = JSON.parse(fs.readFileSync(deployFile, "utf-8")) as {
      deployId?: string
      apiUrl?: string
      claimToken?: string
      url?: string
      timestamp?: string
      publicInspect?: boolean
    }

    if (!deploy.deployId || !deploy.apiUrl || !deploy.claimToken) {
      console.error("This deploy does not have hosted claim metadata.")
      process.exit(1)
    }

    console.log(
      `Note: with user accounts (Phase 3), deploys are auto-owned by the creator. ` +
        `\`pond claim\` is only useful when moving a deploy.json between machines.`
    )

    const response = await fetch(`${deploy.apiUrl}/api/deploys/${deploy.deployId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claimToken: deploy.claimToken,
        envText: fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "",
      }),
    })

    if (!response.ok) {
      throw new Error(`Claim failed: ${response.status}`)
    }

    const remote = (await response.json()) as {
      deployId: string
      url: string
      apiUrl: string
      claimToken: string
      publicInspect: boolean
      claimedAt?: string
      updatedAt?: string
    }

    fs.writeFileSync(
      deployFile,
      JSON.stringify(
        {
          ...deploy,
          deployId: remote.deployId,
          url: remote.url,
          apiUrl: remote.apiUrl,
          claimToken: remote.claimToken,
          publicInspect: remote.publicInspect,
          claimedAt: remote.claimedAt,
          timestamp: remote.updatedAt ?? deploy.timestamp,
        },
        null,
        2
      )
    )

    console.log(`Claimed deploy ${remote.deployId} at ${remote.url}`)
    console.log(`Use \`pond env\` to manage server env going forward.`)
  },
})
