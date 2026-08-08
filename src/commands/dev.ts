import { defineCommand } from "citty"
import { startDevServer } from "../dev-server.js"
import { parsePort } from "./shared.js"

export const devCommand = defineCommand({
  meta: {
    name: "dev",
    description: "Start the development server",
  },
  args: {
    port: {
      type: "string",
      description: "Port to listen on",
      default: "3000",
    },
  },
  async run({ args }) {
    // parsePort fails loudly on garbage instead of "No free port in range NaN-NaN".
    const port = parsePort(typeof args.port === "string" ? args.port : undefined, 3000)
    await startDevServer(port)
  },
})
