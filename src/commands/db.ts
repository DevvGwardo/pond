import { defineCommand, renderUsage } from "citty"
import * as fs from "node:fs"
import { readDeployRecord } from "../host/deploy-record.js"

// citty throws E_NO_COMMAND on bare subcommand-group invocations (e.g. plain
// `pond db`), which renders help AND exits 1 with "ERROR No command
// specified". To match git/npm behavior — print help cleanly, exit 0 — every
// subcommand group sets this as its `run`. It also runs after a subcommand
// fires, so we no-op when args._ already has a positional.
async function showGroupUsageIfBare({ args, cmd }: { args: Record<string, unknown>; cmd: unknown }) {
  const positionals = (args._ as string[] | undefined) ?? []
  if (positionals.length > 0) return
  console.log(await renderUsage(cmd as Parameters<typeof renderUsage>[0]))
}

interface ResolvedTarget {
  baseUrl: string
  headers: Record<string, string>
  source: "explicit" | "auto-remote" | "local"
}

// See logs.ts:resolveTarget for the resolution matrix.
function resolveTarget(target: string | undefined, port: string, local: boolean): ResolvedTarget {
  const localhostUrl = `http://localhost:${port}`
  if (local) {
    return { baseUrl: localhostUrl, headers: {}, source: "local" }
  }
  const deploy = readDeployRecord(process.cwd())
  if (target) {
    if (target.startsWith("http://") || target.startsWith("https://")) {
      return { baseUrl: target.replace(/\/$/, ""), headers: {}, source: "explicit" }
    }
    if (deploy?.deployId === target && deploy?.url) {
      const headers: Record<string, string> = deploy.claimToken ? { "x-pond-claim-token": deploy.claimToken } : {}
      return { baseUrl: deploy.url, headers, source: "explicit" }
    }
    throw new Error(`Unknown deploy target: ${target}`)
  }
  if (deploy?.url && deploy?.claimToken) {
    return {
      baseUrl: deploy.url,
      headers: { "x-pond-claim-token": deploy.claimToken },
      source: "auto-remote",
    }
  }
  return { baseUrl: localhostUrl, headers: {}, source: "local" }
}

let autoRemoteNoticeShown = false
function noticeAutoRemoteOnce(resolved: ResolvedTarget) {
  if (resolved.source !== "auto-remote" || autoRemoteNoticeShown) return
  autoRemoteNoticeShown = true
  console.error(`→ Targeting ${resolved.baseUrl}  (pass --local for the dev server)`)
}

async function request(pathname: string, port: string, target: string | undefined, local: boolean) {
  const resolved = resolveTarget(target, port, local)
  noticeAutoRemoteOnce(resolved)
  const res = await fetch(`${resolved.baseUrl}${pathname}`, { headers: resolved.headers })
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`)
  }
  return res.json()
}

async function rawFetch(
  pathname: string,
  port: string,
  target: string | undefined,
  local: boolean,
  init?: RequestInit,
): Promise<Response> {
  const resolved = resolveTarget(target, port, local)
  noticeAutoRemoteOnce(resolved)
  const headers = new Headers(init?.headers)
  for (const [k, v] of Object.entries(resolved.headers)) headers.set(k, v)
  const res = await fetch(`${resolved.baseUrl}${pathname}`, { ...init, headers })
  return res
}

const LOCAL_FLAG = {
  type: "boolean" as const,
  default: false,
  description: "Force localhost:<port> even if .pond/deploy.json points at a remote deploy",
}

export const dbCommand = defineCommand({
  meta: {
    name: "db",
    description: "Inspect capsule database state",
  },
  run: showGroupUsageIfBare,
  subCommands: {
    list: defineCommand({
      meta: {
        name: "list",
        description: "List tables",
      },
      args: {
        port: { type: "string", default: "3000" },
        target: { type: "string", required: false },
        local: LOCAL_FLAG,
      },
      async run({ args }) {
        const target = typeof args.target === "string" ? args.target : undefined
        const port = typeof args.port === "string" ? args.port : "3000"
        console.log(JSON.stringify(await request("/__pond/db/tables", port, target, Boolean(args.local)), null, 2))
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
        local: LOCAL_FLAG,
      },
      async run({ args }) {
        const target = typeof args.target === "string" ? args.target : undefined
        const port = typeof args.port === "string" ? args.port : "3000"
        const out = String(args.out)
        const res = await rawFetch("/__pond/db/backup", port, target, Boolean(args.local))
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
        local: LOCAL_FLAG,
      },
      async run({ args }) {
        const target = typeof args.target === "string" ? args.target : undefined
        const port = typeof args.port === "string" ? args.port : "3000"
        const inPath = String(args.in)
        const body = fs.readFileSync(inPath)
        const res = await rawFetch("/__pond/db/restore", port, target, Boolean(args.local), {
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
    migrate: defineCommand({
      meta: {
        name: "migrate",
        description:
          "Apply a destructive schema change the auto-migrator refuses: drop or rename a column on the live database.",
      },
      args: {
        drop: { type: "string", required: false, description: "Column to drop, as <table>.<column>" },
        rename: {
          type: "string",
          required: false,
          description: "Column to rename, as <table>.<oldColumn> (with --to)",
        },
        to: { type: "string", required: false, description: "New column name (used with --rename)" },
        port: { type: "string", default: "3000" },
        target: { type: "string", required: false },
        local: LOCAL_FLAG,
      },
      async run({ args }) {
        const target = typeof args.target === "string" ? args.target : undefined
        const port = typeof args.port === "string" ? args.port : "3000"
        const local = Boolean(args.local)

        let payload: { op: string; table: string; column: string; to?: string }
        if (typeof args.drop === "string" && args.drop) {
          const [table, column] = args.drop.split(".")
          if (!table || !column) throw new Error("--drop expects <table>.<column>")
          payload = { op: "drop", table, column }
        } else if (typeof args.rename === "string" && args.rename) {
          const [table, column] = args.rename.split(".")
          if (!table || !column) throw new Error("--rename expects <table>.<oldColumn> together with --to <newColumn>")
          if (typeof args.to !== "string" || !args.to) throw new Error("--rename requires --to <newColumn>")
          payload = { op: "rename", table, column, to: args.to }
        } else {
          throw new Error("specify --drop <table>.<column> or --rename <table>.<oldColumn> --to <newColumn>")
        }

        const res = await rawFetch("/__pond/db/migrate", port, target, local, {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
        })
        const json = (await res.json()) as { ok?: boolean; message?: string; error?: string }
        if (!res.ok || !json.ok) {
          throw new Error(`migrate failed: ${json.error ?? res.status}`)
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
        table: { type: "positional", required: false },
        port: { type: "string", default: "3000" },
        target: { type: "string", required: false },
        local: LOCAL_FLAG,
      },
      async run({ args }) {
        const table = typeof args.table === "string" ? args.table : undefined
        const target = typeof args.target === "string" ? args.target : undefined
        const port = typeof args.port === "string" ? args.port : "3000"
        const local = Boolean(args.local)
        if (table) {
          console.log(JSON.stringify(await request(`/__pond/db/dump/${table}`, port, target, local), null, 2))
          return
        }
        const tables = (await request("/__pond/db/tables", port, target, local)) as string[]
        const dump: Record<string, unknown> = {}
        for (const nextTable of tables) {
          dump[nextTable] = await request(`/__pond/db/dump/${nextTable}`, port, target, local)
        }
        console.log(JSON.stringify(dump, null, 2))
      },
    }),
  },
})
