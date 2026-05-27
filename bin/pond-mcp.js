#!/usr/bin/env node
import { runMcpServer } from "../src/mcp/server.js"
try {
  runMcpServer()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
