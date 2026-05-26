import { defineCommand } from "citty"
import { startDevServer } from "../dev-server.js"

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
    const port = parseInt(args.port, 10)
    await startDevServer(port)
  },
})
