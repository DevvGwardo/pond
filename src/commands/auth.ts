import { defineCommand } from "citty"

export const authCommand = defineCommand({
  meta: {
    name: "auth",
    description: "Manage dev auth state",
  },
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
        const res = await fetch(`http://localhost:${args.port}/__pond/auth/guest`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: args.name }),
        })
        if (!res.ok) throw new Error(`Request failed: ${res.status}`)
        console.log(JSON.stringify(await res.json(), null, 2))
      },
    }),
  },
})
