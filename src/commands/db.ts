import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"

async function request(pathname: string, port: string) {
  const res = await fetch(`http://localhost:${port}${pathname}`)
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`)
  }
  return res.json()
}

function readDeploy(target?: string) {
  if (!target) return null
  const deployFile = path.join(process.cwd(), ".pond", "deploy.json")
  if (!fs.existsSync(deployFile)) {
    throw new Error("No .pond/deploy.json found")
  }
  const deploy = JSON.parse(fs.readFileSync(deployFile, "utf-8")) as {
    deployId: string
    url?: string
  }
  if (deploy.deployId !== target) {
    throw new Error(`Unknown deploy id: ${target}`)
  }
  return deploy
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
        const deploy = readDeploy(target)
        const baseUrl = deploy?.url ?? `http://localhost:${port}`
        const res = await fetch(`${baseUrl}/__pond/db/tables`)
        if (!res.ok) throw new Error(`Request failed: ${res.status}`)
        console.log(JSON.stringify(await res.json(), null, 2))
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
        const deploy = readDeploy(target)
        const baseUrl = deploy?.url ?? `http://localhost:${port}`
        if (table) {
          const res = await fetch(`${baseUrl}/__pond/db/dump/${table}`)
          if (!res.ok) throw new Error(`Request failed: ${res.status}`)
          console.log(JSON.stringify(await res.json(), null, 2))
          return
        }
        const tables = (deploy
          ? await (await fetch(`${baseUrl}/__pond/db/tables`)).json()
          : await request("/__pond/db/tables", port)) as string[]
        const dump: Record<string, unknown> = {}
        for (const table of tables) {
          const res = await fetch(`${baseUrl}/__pond/db/dump/${table}`)
          if (!res.ok) throw new Error(`Request failed: ${res.status}`)
          dump[table] = await res.json()
        }
        console.log(JSON.stringify(dump, null, 2))
      },
    }),
  },
})
