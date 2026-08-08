/**
 * Pond MCP server.
 *
 * Speaks the Model Context Protocol over stdio (JSON-RPC 2.0, line-delimited
 * JSON). Each "tool" maps to one pond control-plane API call so an MCP-capable
 * client (Claude Code, Cursor, etc.) can manage capsules without shelling out.
 *
 * Auth: reads ~/.pond/credentials.json for the configured --api URL (default:
 * https://pond.run). Override with POND_MCP_API.
 */

import { loadCredentials } from "../host/credentials.js"

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string | null
  method: string
  params?: any
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id?: number | string | null
  result?: any
  error?: { code: number; message: string; data?: any }
}

interface ToolDef {
  name: string
  description: string
  inputSchema: object
  handler: (input: any) => Promise<unknown>
}

function send(msg: JsonRpcResponse) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function ok(id: JsonRpcRequest["id"], result: unknown) {
  send({ jsonrpc: "2.0", id, result })
}

function fail(id: JsonRpcRequest["id"], code: number, message: string, data?: any) {
  send({ jsonrpc: "2.0", id, error: { code, message, data } })
}

export interface McpServerOptions {
  apiUrl: string
  token: string
}

function resolveAuth(): McpServerOptions {
  const apiUrl = (process.env.POND_MCP_API ?? "https://pond.run").replace(/\/$/, "")
  const tokenEnv = process.env.POND_MCP_TOKEN
  if (tokenEnv) {
    return { apiUrl, token: tokenEnv }
  }
  const cred = loadCredentials(apiUrl)
  if (!cred) {
    throw new Error(
      `No pond credentials for ${apiUrl}. Run \`pond login --api ${apiUrl} --username <you>\` first, or set POND_MCP_TOKEN.`,
    )
  }
  return { apiUrl, token: cred.token }
}

async function api(opts: McpServerOptions, path: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers ?? {})
  headers.set("authorization", `Bearer ${opts.token}`)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  // A stalled control plane must not hang tools/call forever.
  const res = await fetch(`${opts.apiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) })
  const ct = res.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) {
    const json = await res.json()
    if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`)
    return json
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`)
  return text
}

// Encode one path segment (the host's files routes treat the subpath as a
// URL segment, so spaces/#/? in a filename would otherwise break the request).
function fileUrl(deployId: string, path: string): string {
  return `/api/deploys/${encodeURIComponent(deployId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`
}

function tools(opts: McpServerOptions): ToolDef[] {
  return [
    {
      name: "create_deploy",
      description:
        "Create a new deploy from a source tree and return its live URL. sourceFiles maps relative paths to file contents and MUST include server/index.ts (the entry point). The deploy is owned by the authenticated account. The response includes deployId, url, and a one-time claimToken — save it if you need to claim/transfer the deploy later.",
      inputSchema: {
        type: "object",
        properties: {
          sourceFiles: {
            type: "object",
            description:
              'Map of relative path -> file content, e.g. { "server/index.ts": "...", "package.json": "..." }. Must include server/index.ts.',
            additionalProperties: { type: "string" },
          },
          publicInspect: {
            type: "boolean",
            description: "Allow read-only public inspection of the deploy (default false).",
          },
        },
        required: ["sourceFiles"],
      },
      handler: async ({ sourceFiles, publicInspect }) =>
        api(opts, "/api/deploys", {
          method: "POST",
          body: JSON.stringify({ sourceFiles, publicInspect: Boolean(publicInspect) }),
        }),
    },
    {
      name: "claim_deploy",
      description:
        "Claim an unclaimed (anonymous) deploy to the authenticated account, or re-attach a deploy already owned by this account. Requires the deployId and its current claimToken (from create_deploy). Returns a NEW rotated claimToken — the old one is invalidated, so persist the returned value.",
      inputSchema: {
        type: "object",
        properties: {
          deployId: { type: "string" },
          claimToken: { type: "string", description: "The current claim token for the deploy." },
          envText: {
            type: "string",
            description: "Optional .env contents to set on the deploy as part of the claim (KEY=value lines).",
          },
        },
        required: ["deployId", "claimToken"],
      },
      handler: async ({ deployId, claimToken, envText }) => {
        const body: Record<string, unknown> = { claimToken }
        if (typeof envText === "string") body.envText = envText
        return api(opts, `/api/deploys/${deployId}/claim`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      },
    },
    {
      name: "list_deploys",
      description: "List deploys owned by the current user. Returns id, url, status, createdAt.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => api(opts, "/api/deploys"),
    },
    {
      name: "deploy_files",
      description: "List files in a deploy's source tree.",
      inputSchema: {
        type: "object",
        properties: { deployId: { type: "string" } },
        required: ["deployId"],
      },
      handler: async ({ deployId }) => api(opts, `/api/deploys/${deployId}/files`),
    },
    {
      name: "read_file",
      description: "Read a source file from a deploy's tree (e.g. server/index.ts).",
      inputSchema: {
        type: "object",
        properties: {
          deployId: { type: "string" },
          path: { type: "string", description: "Relative path like server/index.ts" },
        },
        required: ["deployId", "path"],
      },
      handler: async ({ deployId, path }) => api(opts, fileUrl(deployId, path)),
    },
    {
      name: "write_file",
      description: "Overwrite a source file in a deploy's tree. Does not rebuild — call build_deploy afterwards.",
      inputSchema: {
        type: "object",
        properties: {
          deployId: { type: "string" },
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["deployId", "path", "content"],
      },
      // The host's files PUT takes the RAW file text as the body — sending
      // JSON.stringify({content}) would write `{"content":"..."}` to disk.
      handler: async ({ deployId, path, content }) =>
        api(opts, fileUrl(deployId, path), {
          method: "PUT",
          body: content,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    },
    {
      name: "build_deploy",
      description: "Rebuild a deploy's bundle from its current source tree. Returns bundleHash + size.",
      inputSchema: {
        type: "object",
        properties: { deployId: { type: "string" } },
        required: ["deployId"],
      },
      handler: async ({ deployId }) => api(opts, `/api/deploys/${deployId}/build`, { method: "POST" }),
    },
    {
      name: "tail_logs",
      description: "Fetch the last N log entries for a deploy from the control plane.",
      inputSchema: {
        type: "object",
        properties: {
          deployId: { type: "string" },
          limit: { type: "number", description: "Max entries (default 100, max 500)" },
        },
        required: ["deployId"],
      },
      handler: async ({ deployId, limit }) => {
        const n = typeof limit === "number" ? Math.min(Math.max(limit, 1), 500) : 100
        return api(opts, `/api/deploys/${deployId}/logs?limit=${n}`)
      },
    },
    {
      name: "env_list",
      description: "List env keys for a deploy (values masked).",
      inputSchema: {
        type: "object",
        properties: { deployId: { type: "string" } },
        required: ["deployId"],
      },
      handler: async ({ deployId }) => api(opts, `/api/deploys/${deployId}/env`),
    },
    {
      name: "env_set",
      description: "Set an env var on a deploy. Triggers a rebuild + restart on the host side.",
      inputSchema: {
        type: "object",
        properties: {
          deployId: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["deployId", "key", "value"],
      },
      handler: async ({ deployId, key, value }) => {
        // The host's env API is `{ entries: {...} }` on both GET and PUT —
        // not an envText blob. Merge into the current entries so unrelated
        // keys survive.
        const cur = (await api(opts, `/api/deploys/${deployId}/env`)) as { entries?: Record<string, string> }
        const entries = { ...(cur.entries ?? {}) }
        entries[key] = value
        return api(opts, `/api/deploys/${deployId}/env`, {
          method: "PUT",
          body: JSON.stringify({ entries }),
        })
      },
    },
  ]
}

export function runMcpServer() {
  const opts = resolveAuth()
  const toolList = tools(opts)
  const toolMap = new Map(toolList.map((t) => [t.name, t]))

  let buf = ""
  process.stdin.setEncoding("utf-8")
  process.stdin.on("data", (chunk) => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let req: JsonRpcRequest
      try {
        req = JSON.parse(line) as JsonRpcRequest
      } catch (err) {
        fail(null, -32700, "Parse error", err instanceof Error ? err.message : String(err))
        continue
      }
      void handle(req).catch((err) =>
        fail(req.id ?? null, -32603, "Internal error", err instanceof Error ? err.message : String(err)),
      )
    }
  })

  process.stdin.on("end", () => process.exit(0))

  async function handle(req: JsonRpcRequest) {
    if (req.method === "initialize") {
      ok(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pond", version: "0.1.0" },
      })
      return
    }
    // JSON-RPC notifications (no `id`) must NEVER be answered. The client
    // doesn't expect a response, and sending one is a protocol violation.
    if (req.method?.startsWith("notifications/")) {
      return
    }
    if (req.method === "tools/list") {
      ok(req.id, {
        tools: toolList.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
      return
    }
    if (req.method === "tools/call") {
      // Validate params up front: a missing/odd params object is an Invalid
      // params error (-32602), not an Internal error (-32603).
      if (!req.params || typeof req.params !== "object" || typeof req.params.name !== "string") {
        fail(req.id ?? null, -32602, "Invalid params: tools/call requires a params object with a string `name`")
        return
      }
      const params = req.params as { name: string; arguments?: Record<string, unknown> }
      const tool = toolMap.get(params.name)
      if (!tool) {
        fail(req.id ?? null, -32601, `Unknown tool: ${params.name}`)
        return
      }
      try {
        const result = await tool.handler(params.arguments ?? {})
        ok(req.id, {
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        })
      } catch (err) {
        ok(req.id, {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        })
      }
      return
    }
    fail(req.id ?? null, -32601, `Method not found: ${req.method}`)
  }

  console.error(`[pond-mcp] connected to ${opts.apiUrl} (${toolList.length} tools)`)
}
