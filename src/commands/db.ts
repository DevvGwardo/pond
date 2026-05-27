import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"

function resolveRemoteTarget(target?: string) {
  const deployFile = path.join(process.cwd(), ".pond", "deploy.json")
  if (!fs.existsSync(deployFile)) return null
  const deploy = JSON.parse(fs.readFileSync(deployFile, "utf-8")) as {
    deployId?: string
    url?: string
    claimToken?: string
  }
  if (!target) return null
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return {
      baseUrl: target.replace(/\/$/, ""),
      headers: {} as Record<string, string>,
    }
  }
  if (deploy.deployId === target && deploy.url) {
    return {
      baseUrl: deploy.url,
      headers: deploy.claimToken ? { "x-pond-claim-token": deploy.claimToken } : ({} as Record<string, string>),
    }
  }
  throw new Error(`Unknown deploy target: ${target}`)
}

async function request(pathname: string, port: string, target?: string) {
  const remote = resolveRemoteTarget(target)
  const baseUrl = remote?.baseUrl ?? `http://localhost:${port}`
  const res = await fetch(`${baseUrl}${pathname}`, {
    headers: remote?.headers,
  })
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`)
  }
  return res.json()
}

async function rawFetch(pathname: string, port: string, target?: string, init?: RequestInit): Promise<Response> {
  const remote = resolveRemoteTarget(target)
  const baseUrl = remote?.baseUrl ?? `http://localhost:${port}`
  const headers = new Headers(init?.headers)
  for (const [k, v] of Object.entries(remote?.headers ?? {})) headers.set(k, v)
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers })
  return res
}

export const dbCommand = defineCommand({
  meta: {
    name: "db",
    description: "Inspect capsule database state",
  },
  subCommands: {
    list: defineCommand({
      meta: {
        name: "list",
        description: "List tables",
      },
      args: {
        port: {
          type: "string",
          default: "3000",
        },
        target: {
          type: "string",
          required: false,
        },
      },
      async run({ args }) {
        const target = typeof args.target === "string" ? args.target : undefined
        const port = typeof args.port === "string" ? args.port : "3000"
        console.log(JSON.stringify(await request("/__pond/db/tables", port, target), null, 2))
      },
    }),
    backup: defineCommand({
      meta: {
        name: "backup",
        description: "Snapshot the capsule's SQLite database to a local file (uses VACUUM INTO).",
      },
      args: {
        out: { type: "string", required: true, description: "Output file path" },
        port: { type: "string", default: "3000" },
        target: { type: "string", required: false },
      },
      async run({ args }) {
        const target = typeof args.target === "string" ? args.target : undefined
        const port = typeof args.port === "string" ? args.port : "3000"
        const out = String(args.out)
        const res = await rawFetch("/__pond/db/backup", port, target)
        if (!res.ok) {
          const body = await res.text().catch(() => "")
          throw new Error(`backup failed: ${res.status} ${body}`)
        }
        const buf = Buffer.from(await res.arrayBuffer())
        fs.writeFileSync(out, buf)
        console.log(`Wrote ${buf.length} bytes to ${out}`)
      },
    }),
    restore: defineCommand({
      meta: {
        name: "restore",
        description:
          "Upload a SQLite snapshot. The capsule writes it to .pond/data.db.restored — restart the process to swap.",
      },
      args: {
        in: { type: "string", required: true, description: "Input file path" },
        port: { type: "string", default: "3000" },
        target: { type: "string", required: false },
      },
      async run({ args }) {
        const target = typeof args.target === "string" ? args.target : undefined
        const port = typeof args.port === "string" ? args.port : "3000"
        const inPath = String(args.in)
        const body = fs.readFileSync(inPath)
        const res = await rawFetch("/__pond/db/restore", port, target, {
          method: "POST",
          body: body as unknown as BodyInit,
          headers: { "content-type": "application/x-sqlite3" },
        })
        const json = (await res.json()) as { ok?: boolean; message?: string; error?: string }
        if (!res.ok || !json.ok) {
          throw new Error(`restore failed: ${json.error ?? res.status}`)
        }
        console.log(json.message)
      },
    }),
    dump: defineCommand({
      meta: {
        name: "dump",
        description: "Dump table contents",
      },
      args: {
        table: {
          type: "positional",
          required: false,
        },
        port: {
          type: "string",
          default: "3000",
        },
        target: {
          type: "string",
          required: false,
        },
      },
      async run({ args }) {
        const table = typeof args.table === "string" ? args.table : undefined
        const target = typeof args.target === "string" ? args.target : undefined
        const port = typeof args.port === "string" ? args.port : "3000"
        if (table) {
          console.log(JSON.stringify(await request(`/__pond/db/dump/${table}`, port, target), null, 2))
          return
        }
        const tables = (await request("/__pond/db/tables", port, target)) as string[]
        const dump: Record<string, unknown> = {}
        for (const nextTable of tables) {
          dump[nextTable] = await request(`/__pond/db/dump/${nextTable}`, port, target)
        }
        console.log(JSON.stringify(dump, null, 2))
      },
    }),
  },
})
