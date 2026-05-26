import { defineCommand } from "citty"
import { saveCredentials } from "../host/credentials.js"

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description: "Bootstrap or attach a user identity for a pond control plane",
  },
  args: {
    api: { type: "string", required: true },
    username: { type: "string", required: false },
    token: { type: "string", required: false, description: "Existing user token to attach" },
    "admin-token": {
      type: "string",
      required: false,
      description: "Admin user token to create a new user (admin-only)",
    },
  },
  async run({ args }) {
    const apiUrl = String(args.api).replace(/\/$/, "")
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
        "Need credentials to create a user. Pass --admin-token <token> (admin user) or set POND_HOST_TOKEN (bootstrap first admin).",
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
  },
})
