import { defineCommand } from "citty"
import { fail, fetchOrFail, showGroupUsageIfBare } from "./shared.js"

export const authCommand = defineCommand({
  meta: {
    name: "auth",
    description: "Manage dev auth state",
  },
  run: showGroupUsageIfBare,
  subCommands: {
    as: defineCommand({
      meta: {
        name: "as",
        description: "Set the current guest identity",
      },
      args: {
        name: {
          type: "positional",
          required: true,
        },
        port: {
          type: "string",
          default: "3000",
        },
      },
      async run({ args }) {
        const res = await fetchOrFail(`http://localhost:${args.port}/__pond/auth/guest`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: args.name }),
        })
        if (!res.ok) fail(`Request failed: HTTP ${res.status}`)
        console.log(JSON.stringify(await res.json(), null, 2))
      },
    }),
  },
})
