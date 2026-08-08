import { defineCommand } from "citty"
import * as fs from "node:fs"
import { loadCredentials, saveCredentials } from "../host/credentials.js"
import { deployRecordPath, readDeployRecord } from "../host/deploy-record.js"
import * as path from "node:path"
import { fail, fetchOrFail } from "./shared.js"

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
    const deployFile = deployRecordPath(cwd)
    const envFile = path.join(cwd, ".env.pond.server")

    const deploy = readDeployRecord(cwd)
    if (!deploy) {
      console.error("No .pond/deploy.json found. Run `pond deploy --api ...` first.")
      process.exit(1)
    }

    const apiUrl = (typeof args.api === "string" && args.api ? args.api.replace(/\/$/, "") : undefined) ?? deploy.apiUrl

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
          `No saved credentials for ${apiUrl}. Pass --signup <username> to create one, or run \`pond login --api ${apiUrl} --username <name>\` first.`,
        )
        process.exit(1)
      }
      headers.authorization = `Bearer ${cred.token}`
    }

    const response = await fetchOrFail(`${apiUrl}/api/deploys/${deploy.deployId}/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      fail(`Claim failed: ${response.status} ${text}`)
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

    // Trust the apiUrl we sent to, not the server's echoed remote.apiUrl —
    // some control planes echo back their internal bind address (e.g.
    // http://0.0.0.0:8787), which would poison every subsequent CLI read of
    // .pond/deploy.json. The user reached this server through `apiUrl`;
    // that's the authoritative public address. Mirror of the same rule in
    // deploy.ts and signup.ts.
    let savedUsername: string | null = null
    if (remote.user) {
      const saved = saveCredentials({
        apiUrl,
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
          apiUrl,
          claimToken: remote.claimToken,
          publicInspect: remote.publicInspect,
          claimedAt: remote.claimedAt,
          timestamp: remote.updatedAt ?? deploy.timestamp,
          terminatesAt: undefined,
          expiresAt: undefined,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    try {
      fs.chmodSync(deployFile, 0o600)
    } catch {
      // best-effort on platforms without chmod
    }

    console.log(`Claimed deploy ${remote.deployId}${savedUsername ? ` for ${savedUsername}` : ""} at ${remote.url}`)
    if (remote.user) {
      console.log(`  Saved credentials to ~/.pond/credentials.json`)
    }
    console.log(`  Dashboard: ${apiUrl}/dashboard  (or: pond dashboard)`)
  },
})
