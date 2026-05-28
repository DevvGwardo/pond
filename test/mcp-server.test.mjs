// Wiring test for the pond MCP server (src/mcp/server.ts), focused on the two
// lifecycle tools create_deploy and claim_deploy. It drives the real stdio
// server (bin/pond-mcp.js) over JSON-RPC and points POND_MCP_API at a stub
// HTTP server so we can assert the exact method, path, body, and auth header
// each tool sends to the control plane — without needing a live pond host.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as http from "node:http"
import * as path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const MCP_BIN = path.join(REPO_ROOT, "bin", "pond-mcp.js")
const TOKEN = "test-token-123"

function startStub() {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      calls.push({
        method: req.method,
        url: req.url,
        auth: req.headers["authorization"],
        body: body ? JSON.parse(body) : null,
      })
      // Echo back a record shaped like the control plane's real responses.
      res.setHeader("content-type", "application/json")
      res.statusCode = 201
      res.end(JSON.stringify({ deployId: "abc123", url: "https://pond.run/abc123", claimToken: "rotated-token" }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({ server, calls, apiUrl: `http://127.0.0.1:${port}` })
    })
  })
}

// Drive the stdio MCP server: send the given JSON-RPC requests, resolve once a
// response for `waitForId` arrives (or the process exits).
function driveMcp(apiUrl, requests, waitForId) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [MCP_BIN], {
      env: { ...process.env, POND_MCP_API: apiUrl, POND_MCP_TOKEN: TOKEN },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let stderr = ""
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error(`MCP server timed out. stderr: ${stderr}\nstdout: ${out}`))
    }, 15000)
    timer.unref()
    proc.stdout.on("data", (d) => {
      out += d
      for (const line of out.split("\n")) {
        const t = line.trim()
        if (!t) continue
        let msg
        try {
          msg = JSON.parse(t)
        } catch {
          continue
        }
        if (msg.id === waitForId) {
          clearTimeout(timer)
          proc.kill("SIGTERM")
          resolve(msg)
          return
        }
      }
    })
    proc.stderr.on("data", (d) => (stderr += d))
    proc.on("error", reject)
    for (const r of requests) proc.stdin.write(JSON.stringify(r) + "\n")
  })
}

test("create_deploy POSTs sourceFiles to /api/deploys with bearer auth", async () => {
  const { server, calls, apiUrl } = await startStub()
  try {
    await driveMcp(
      apiUrl,
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_deploy",
            arguments: { sourceFiles: { "server/index.ts": "export default {}" }, publicInspect: true },
          },
        },
      ],
      2,
    )
  } finally {
    server.close()
  }
  const call = calls.find((c) => c.url === "/api/deploys")
  assert.ok(call, `expected a call to /api/deploys, got ${JSON.stringify(calls)}`)
  assert.equal(call.method, "POST")
  assert.equal(call.auth, `Bearer ${TOKEN}`)
  assert.deepEqual(call.body.sourceFiles, { "server/index.ts": "export default {}" })
  assert.equal(call.body.publicInspect, true)
})

test("claim_deploy POSTs claimToken to /api/deploys/:id/claim with bearer auth", async () => {
  const { server, calls, apiUrl } = await startStub()
  try {
    await driveMcp(
      apiUrl,
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "claim_deploy",
            arguments: { deployId: "abc123", claimToken: "ct-xyz", envText: "FOO=bar\n" },
          },
        },
      ],
      2,
    )
  } finally {
    server.close()
  }
  const call = calls.find((c) => c.url === "/api/deploys/abc123/claim")
  assert.ok(call, `expected a call to /api/deploys/abc123/claim, got ${JSON.stringify(calls)}`)
  assert.equal(call.method, "POST")
  assert.equal(call.auth, `Bearer ${TOKEN}`)
  assert.equal(call.body.claimToken, "ct-xyz")
  assert.equal(call.body.envText, "FOO=bar\n")
})

test("tools/list advertises create_deploy and claim_deploy", async () => {
  // No HTTP call needed; point at an unused port.
  const res = await driveMcp(
    "http://127.0.0.1:9",
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
    2,
  )
  const names = res.result.tools.map((t) => t.name)
  assert.ok(names.includes("create_deploy"), `missing create_deploy: ${names.join(", ")}`)
  assert.ok(names.includes("claim_deploy"), `missing claim_deploy: ${names.join(", ")}`)
})
