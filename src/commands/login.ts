import { defineCommand } from "citty"
import { saveCredentials } from "../host/credentials.js"

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description: "Bootstrap or attach a user identity for a pond control plane",
  },
  args: {
    api: {
      type: "string",
      required: false,
      default: "https://pond.run",
      description: "Control plane URL (default: https://pond.run)",
    },
    username: { type: "string", required: false },
    token: { type: "string", required: false, description: "Existing user token to attach" },
    "admin-token": {
      type: "string",
      required: false,
      description: "Admin user token to create a new user (admin-only)",
    },
  },
  async run({ args }) {
    // Catch the common citty footgun: an empty `--api` swallows the next flag
    // ("--username") as its value, then complains it can't reach a control
    // plane at "--username". Detect & explain instead.
    const apiRaw = String(args.api ?? "")
    if (apiRaw.startsWith("--") || apiRaw === "") {
      console.error(
        `--api expects a URL value, got "${apiRaw || "(empty)"}". Try \`pond login --username <name> --token <token>\` — --api defaults to https://pond.run.`,
      )
      process.exit(1)
    }
    const apiUrl = apiRaw.replace(/\/$/, "")
    const username = typeof args.username === "string" ? args.username : ""
    const token = typeof args.token === "string" ? args.token : ""
    const adminToken = typeof args["admin-token"] === "string" ? args["admin-token"] : ""

    if (token) {
      if (!username) {
        console.error("--token requires --username (label for the saved credential)")
        process.exit(1)
      }
      const meRes = await fetch(`${apiUrl}/api/users/me`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!meRes.ok) {
        console.error(`Token rejected: ${meRes.status}`)
        process.exit(1)
      }
      const me = (await meRes.json()) as { username: string; isAdmin: boolean }
      const saved = saveCredentials({ apiUrl, username: me.username, token, isAdmin: me.isAdmin })
      console.log(`Logged in as ${saved.username}${saved.isAdmin ? " (admin)" : ""} at ${saved.apiUrl}`)
      console.log(`  Dashboard: ${saved.apiUrl}/dashboard  (or: pond dashboard)`)
      return
    }

    if (!username) {
      console.error("--username is required")
      process.exit(1)
    }

    // Need to create a user. Use admin-token if given, otherwise POND_HOST_TOKEN (bootstrap).
    const authToken = adminToken || process.env.POND_HOST_TOKEN || ""
    if (!authToken) {
      console.error(
        `Need a token to attach. Three paths forward:
  1. If you already deployed anonymously: \`pond signup <username>\` — creates an account on the control plane and claims that deploy.
  2. Existing token: \`pond login --token <token> --username <name>\` (or --api <self-hosted-url>).
  3. Self-hosted bootstrap: set POND_HOST_TOKEN env var, or pass --admin-token <token>.`,
      )
      process.exit(1)
    }

    const res = await fetch(`${apiUrl}/api/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ username }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.error(`User create failed: ${res.status} ${text}`)
      process.exit(1)
    }

    const created = (await res.json()) as {
      userId: string
      username: string
      isAdmin: boolean
      token: string
    }
    const saved = saveCredentials({
      apiUrl,
      username: created.username,
      token: created.token,
      isAdmin: created.isAdmin,
    })
    console.log(`Created user ${saved.username}${saved.isAdmin ? " (admin)" : ""} at ${saved.apiUrl}`)
    console.log(`Token saved to ~/.pond/credentials.json (mode 0600).`)
    console.log(`Dashboard: ${saved.apiUrl}/dashboard  (or: pond dashboard)`)
  },
})
