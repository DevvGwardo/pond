import { defineCommand } from "citty"
import { loadCredentials, saveCredentials } from "../host/credentials.js"

export const tokenCommand = defineCommand({
  meta: {
    name: "token",
    description: "Manage the saved user API token",
  },
  subCommands: {
    rotate: defineCommand({
      meta: {
        name: "rotate",
        description: "Rotate the saved user token for an API",
      },
      args: {
        api: { type: "string", required: true },
      },
      async run({ args }) {
        const apiUrl = String(args.api).replace(/\/$/, "")
        const cred = loadCredentials(apiUrl)
        if (!cred) {
          console.error(`No saved credentials for ${apiUrl}.`)
          process.exit(1)
        }
        const res = await fetch(`${apiUrl}/api/users/me/rotate-token`, {
          method: "POST",
          headers: { authorization: `Bearer ${cred.token}` },
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          console.error(`Rotate failed: ${res.status} ${text}`)
          process.exit(1)
        }
        const out = (await res.json()) as { token: string }
        saveCredentials({ apiUrl, username: cred.username, token: out.token, isAdmin: cred.isAdmin })
        console.log(`Rotated token for ${cred.username} @ ${apiUrl}.`)
      },
    }),
  },
})
