import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { saveCredentials } from "../host/credentials.js"

// Friendly first-account flow: `pond signup <name>` creates an account on the
// control plane and claims the local anonymous deploy under it. Equivalent to
// `pond claim --signup <name>` but the command name matches the user's mental
// model ("I want to sign up") instead of leading with `claim`.
export const signupCommand = defineCommand({
  meta: {
    name: "signup",
    description: "Create an account on a pond control plane and claim the current anonymous deploy under it",
  },
  args: {
    username: {
      type: "positional",
      description: "Username for the new account (matches /^[a-z0-9_-]{1,32}$/i)",
      required: true,
    },
    api: {
      type: "string",
      description: "Override the apiUrl from .pond/deploy.json",
      required: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd()
    const deployFile = path.join(cwd, ".pond", "deploy.json")

    if (!fs.existsSync(deployFile)) {
      console.error(
        `No .pond/deploy.json in this directory. Run \`pond deploy\` first to create an anonymous deploy, then \`pond signup <name>\` to claim it under your account.`,
      )
      process.exit(1)
    }

    const deploy = JSON.parse(fs.readFileSync(deployFile, "utf-8")) as {
      deployId?: string
      apiUrl?: string
      claimToken?: string
    }

    const apiArg = typeof args.api === "string" && args.api ? args.api : ""
    if (apiArg.startsWith("--")) {
      console.error(`--api expects a URL value, got "${apiArg}". Did you leave --api empty?`)
      process.exit(1)
    }
    const apiUrl = (apiArg ? apiArg.replace(/\/$/, "") : undefined) ?? deploy.apiUrl

    if (!deploy.deployId || !apiUrl || !deploy.claimToken) {
      console.error(
        `This deploy isn't a claimable hosted deploy. Run \`pond deploy\` first to create an anonymous hosted deploy, then \`pond signup <name>\`.`,
      )
      process.exit(1)
    }

    const username = String(args.username).trim()
    if (!/^[a-z0-9_-]{1,32}$/i.test(username)) {
      console.error(`Username must match /^[a-z0-9_-]{1,32}$/i — got "${username}"`)
      process.exit(1)
    }

    const envFile = path.join(cwd, ".env.pond.server")
    const body: Record<string, unknown> = {
      claimToken: deploy.claimToken,
      signup: { username },
    }
    if (fs.existsSync(envFile)) {
      body.envText = fs.readFileSync(envFile, "utf-8")
    }

    const response = await fetch(`${apiUrl}/api/deploys/${deploy.deployId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      console.error(`Signup failed: ${response.status} ${text}`)
      process.exit(1)
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

    if (!remote.user) {
      console.error(
        `Signup didn't return user credentials. The server may have routed this through an existing-user path. Try \`pond login --token <token>\` instead.`,
      )
      process.exit(1)
    }

    // Trust the apiUrl we sent to, not the server's echoed remote.apiUrl —
    // some control planes echo their internal bind address back (see 0.3.0
    // notes in deploy.ts). The saved credentials and deploy record use the
    // address the user actually reached.
    const saved = saveCredentials({
      apiUrl,
      username: remote.user.username,
      token: remote.user.token,
      isAdmin: false,
    })

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
          timestamp: remote.updatedAt ?? new Date().toISOString(),
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

    console.log(`Signed up as ${saved.username} at ${saved.apiUrl}`)
    console.log(`  Claimed deploy: ${remote.url}`)
    console.log(`  Credentials saved to ~/.pond/credentials.json`)
    console.log(`  Dashboard: ${saved.apiUrl}/dashboard  (or: pond dashboard)`)
  },
})
