import { defineCommand } from "citty"
import { fetchOrFail, showGroupUsageIfBare } from "./shared.js"

const terminateCommand = defineCommand({
  meta: {
    name: "terminate",
    description: "Terminate a deploy's worker (operator kill switch). Requires the host token.",
  },
  args: {
    deployId: {
      type: "positional",
      required: true,
      description: "The deployId to terminate",
    },
    api: {
      type: "string",
      required: true,
      description: "Control plane base URL (e.g. http://127.0.0.1:8787)",
    },
    "host-token": {
      type: "string",
      required: false,
      description: "Host token. Defaults to POND_HOST_TOKEN.",
    },
  },
  async run({ args }) {
    const deployId = typeof args.deployId === "string" ? args.deployId : ""
    const apiUrl = (typeof args.api === "string" ? args.api : "").replace(/\/$/, "")
    const token =
      (typeof args["host-token"] === "string" && args["host-token"]
        ? args["host-token"]
        : process.env.POND_HOST_TOKEN) ?? ""
    if (!apiUrl) {
      console.error("--api is required (e.g. --api http://127.0.0.1:8787)")
      process.exit(1)
    }
    if (!token) {
      console.error("No host token. Pass --host-token <token> or set POND_HOST_TOKEN.")
      process.exit(1)
    }

    const res = await fetchOrFail(`${apiUrl}/api/admin/deploys/${deployId}/terminate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.error(`Terminate failed: ${res.status} ${text}`)
      process.exit(1)
    }
    const body = (await res.json()) as { deployId: string; anonymous: boolean }
    console.log(`Terminated deploy ${body.deployId}${body.anonymous ? " (anonymous)" : ""}.`)
  },
})

export const adminCommand = defineCommand({
  meta: {
    name: "admin",
    description: "Host-token-gated operator commands for a pond control plane",
  },
  run: showGroupUsageIfBare,
  subCommands: {
    terminate: terminateCommand,
  },
})
