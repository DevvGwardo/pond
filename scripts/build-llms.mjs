#!/usr/bin/env node
// Generate docs/llms-full.txt by concatenating the agent-targeted docs.
// Run automatically by `npm run build`. Keeps the agent-consumable single-file
// dump in sync with the canonical Markdown references.

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const DOCS = path.join(ROOT, "docs")
const OUTPUT = path.join(DOCS, "llms-full.txt")

const sources = [
  { path: "llms.txt", title: "Pond Docs Index" },
  { path: "api-reference.md", title: "Server API Reference (pond/server)" },
  { path: "client-reference.md", title: "Client API Reference (pond/client)" },
  { path: "cli-reference.md", title: "CLI Reference (pond <command>)" },
]

const blocks = []
blocks.push("# Pond Docs Full Text")
blocks.push("")
blocks.push(
  "This file concatenates the public agent-targeted docs in source order so an agent can ingest the whole pond capsule contract with one fetch.",
)
blocks.push("")
blocks.push("---")

for (const src of sources) {
  const abs = path.join(DOCS, src.path)
  if (!fs.existsSync(abs)) {
    console.error(`[build-llms] missing source: ${abs}`)
    process.exit(1)
  }
  const body = fs.readFileSync(abs, "utf-8").trimEnd()
  blocks.push("")
  blocks.push(`<!-- source: docs/${src.path} -->`)
  blocks.push(`<!-- raw: https://pond.run/docs/${src.path} -->`)
  blocks.push("")
  blocks.push(body)
  blocks.push("")
  blocks.push("---")
}

const out = blocks.join("\n") + "\n"
fs.writeFileSync(OUTPUT, out)
console.log(`[build-llms] wrote ${OUTPUT} (${(out.length / 1024).toFixed(1)} KB)`)
