import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { loadCredentials, saveCredentials } from "../host/credentials.js"

export const claimCommand = defineCommand({
  meta: {
    name: "claim",
    description: "Claim an anonymous hosted deploy (optionally creating a user)",
  },
  args: {
    signup: {
      type: "string",
      description: "Create a new user with this username and claim the deploy",
      required: false,
    },
    api: {
      type: "string",
      description: "Override apiUrl (defaults to value in .pond/deploy.json)",
      required: false,
    },
  },
  async run({ args }) {
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
      claimedAt?: string
    }

    const apiUrl =
      (typeof args.api === "string" && args.api ? args.api.replace(/\/$/, "") : undefined) ?? deploy.apiUrl

    if (!deploy.deployId || !apiUrl || !deploy.claimToken) {
      console.error("This deploy does not have hosted claim metadata.")
      process.exit(1)
    }

    const signupName = typeof args.signup === "string" && args.signup ? args.signup : null

    const headers: Record<string, string> = { "content-type": "application/json" }
    const body: Record<string, unknown> = {
      claimToken: deploy.claimToken,
    }
    if (fs.existsSync(envFile)) {
      body.envText = fs.readFileSync(envFile, "utf-8")
    }

    if (signupName) {
      body.signup = { username: signupName }
    } else {
      const cred = loadCredentials(apiUrl)
      if (!cred) {
        console.error(
          `No saved credentials for ${apiUrl}. Pass --signup <username> to create one, or run \`pond login --api ${apiUrl} --username <name>\` first.`
        )
        process.exit(1)
      }
      headers.authorization = `Bearer ${cred.token}`
    }

    const response = await fetch(`${apiUrl}/api/deploys/${deploy.deployId}/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Claim failed: ${response.status} ${text}`)
    }

    const remote = (await response.json()) as {
      deployId: string
      url: string
      apiUrl: string
      claimToken: string
      publicInspect: boolean
      claimedAt?: string
      updatedAt?: string
      user?: { username: string; token: string }
    }

    let savedUsername: string | null = null
    if (remote.user) {
      const saved = saveCredentials({
        apiUrl: remote.apiUrl,
        username: remote.user.username,
        token: remote.user.token,
        isAdmin: false,
      })
      savedUsername = saved.username
    } else {
      const cred = loadCredentials(apiUrl)
      savedUsername = cred?.username ?? null
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
          terminatesAt: undefined,
          expiresAt: undefined,
        },
        null,
        2
      )
    )

    console.log(`Claimed deploy ${remote.deployId}${savedUsername ? ` for ${savedUsername}` : ""} at ${remote.url}`)
    if (remote.user) {
      console.log(`  Saved credentials to ~/.pond/credentials.json`)
    }
  },
})
