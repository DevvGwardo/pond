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
  const res = await fetch(`${opts.apiUrl}${path}`, { ...init, headers })
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

function tools(opts: McpServerOptions): ToolDef[] {
  return [
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
      handler: async ({ deployId, path }) => api(opts, `/api/deploys/${deployId}/files/${path}`),
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
      handler: async ({ deployId, path, content }) =>
        api(opts, `/api/deploys/${deployId}/files/${path}`, {
          method: "PUT",
          body: JSON.stringify({ content }),
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
      description: "Fetch the last N log entries for a deploy by reading the replayed history from its SSE feed.",
      inputSchema: {
        type: "object",
        properties: {
          deployId: { type: "string" },
          limit: { type: "number", description: "Max entries (default 100)" },
        },
        required: ["deployId"],
      },
      handler: async ({ deployId, limit }) => {
        const n = typeof limit === "number" ? Math.min(Math.max(limit, 1), 500) : 100
        const deploys = (await api(opts, "/api/deploys")) as Array<{ deployId: string; url?: string }>
        const found = deploys.find((d) => d.deployId === deployId)
        if (!found?.url) throw new Error(`No URL for deploy ${deployId}`)
        const ac = new AbortController()
        const t = setTimeout(() => ac.abort(), 1500)
        try {
          const res = await fetch(`${found.url}/__pond/logs`, {
            headers: { authorization: `Bearer ${opts.token}` },
            signal: ac.signal,
          })
          if (!res.ok || !res.body) throw new Error(`logs: ${res.status}`)
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ""
          const events: any[] = []
          while (events.length < n) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            const parts = buf.split("\n\n")
            buf = parts.pop() ?? ""
            for (const part of parts) {
              const dl = part.split("\n").find((l) => l.startsWith("data: "))
              if (!dl) continue
              try {
                events.push(JSON.parse(dl.slice(6)))
              } catch {
                // skip malformed
              }
            }
          }
          return events.slice(-n)
        } finally {
          clearTimeout(t)
        }
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
        const cur = (await api(opts, `/api/deploys/${deployId}/env`)) as { envText?: string }
        const lines = (cur.envText ?? "").split("\n").filter((l: string) => l.length > 0)
        const filtered = lines.filter((l: string) => !new RegExp(`^${key}=`).test(l))
        filtered.push(`${key}=${value}`)
        return api(opts, `/api/deploys/${deployId}/env`, {
          method: "PUT",
          body: JSON.stringify({ envText: filtered.join("\n") + "\n" }),
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
    if (req.method === "notifications/initialized") {
      return
    }
    if (req.method === "tools/list") {
      ok(req.id, {
        tools: toolList.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
      return
    }
    if (req.method === "tools/call") {
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
