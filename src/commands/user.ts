import { defineCommand } from "citty"
import { fetchOrFail, showGroupUsageIfBare } from "./shared.js"
import { loadCredentials } from "../host/credentials.js"

export const userCommand = defineCommand({
  meta: {
    name: "user",
    description: "Manage pond control-plane users",
  },
  run: showGroupUsageIfBare,
  subCommands: {
    create: defineCommand({
      meta: {
        name: "create",
        description: "Create a new user (admin only)",
      },
      args: {
        api: { type: "string", required: true },
        username: { type: "positional", required: true },
        admin: { type: "boolean", default: false },
      },
      async run({ args }) {
        const apiUrl = String(args.api).replace(/\/$/, "")
        const cred = loadCredentials(apiUrl)
        if (!cred) {
          console.error(`No saved credentials for ${apiUrl}. Run \`pond login\` first.`)
          process.exit(1)
        }
        const res = await fetchOrFail(`${apiUrl}/api/users`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cred.token}`,
          },
          body: JSON.stringify({ username: args.username, isAdmin: Boolean(args.admin) }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          console.error(`Create failed: ${res.status} ${text}`)
          process.exit(1)
        }
        const out = (await res.json()) as {
          userId: string
          username: string
          isAdmin: boolean
          token: string
        }
        console.log(`Created user ${out.username}${out.isAdmin ? " (admin)" : ""}`)
        console.log(`Token (shown once — save it now):`)
        console.log(out.token)
        console.log(`\nAttach on the user's machine with:`)
        console.log(`  pond login --api ${apiUrl} --username ${out.username} --token ${out.token}`)
      },
    }),
  },
})
