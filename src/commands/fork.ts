import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { randomBytes } from "node:crypto"

const SLUG_RE = /^[a-z][a-z0-9_-]*$/i

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "fork"
  )
}

// Pull a deployId out of any pond URL — `https://abcdef0123456789.pond.run`
// becomes `abcdef0123456789`. Returns null if the input doesn't parse cleanly.
function deployIdFromUrl(input: string): { deployId: string; origin: string } | null {
  try {
    const u = new URL(input)
    const host = u.host.toLowerCase()
    const sub = host.split(":")[0].split(".")[0]
    if (!/^[a-f0-9]{16}$/.test(sub)) return null
    const origin = `${u.protocol}//${u.host}`
    return { deployId: sub, origin }
  } catch {
    return null
  }
}

export const forkCommand = defineCommand({
  meta: {
    name: "fork",
    description:
      "Fork a public capsule. Pulls source from a deploy URL and scaffolds a local copy ready for `pond dev`.",
  },
  args: {
    source: {
      type: "positional",
      description: "Deploy URL (https://<id>.pond.run) or deployId",
      required: true,
    },
    name: {
      type: "string",
      description: "Local directory name (default: derived from title or deployId)",
    },
    api: {
      type: "string",
      description: "Control plane base URL (default: derived from the deploy URL)",
    },
    git: {
      type: "boolean",
      description: "Initialize a git repo in the new directory (use --no-git to skip)",
      default: true,
    },
  },
  async run({ args }) {
    const source = String(args.source)
    const parsed = deployIdFromUrl(source)
    const deployId = parsed?.deployId ?? (/^[a-f0-9]{16}$/.test(source) ? source : null)
    if (!deployId) {
      console.error(
        `Could not parse a deployId from "${source}". Pass an https://<id>.pond.run URL or a 16-char hex id.`,
      )
      process.exit(1)
    }
    // Where to fetch the source from. If the user gave us a URL we use its
    // origin; otherwise the explicit --api flag; otherwise default to the
    // public pond.run host.
    const apiBase = (() => {
      const flag = typeof args.api === "string" ? args.api : ""
      if (flag) return flag.replace(/\/$/, "")
      if (parsed?.origin) {
        // Drop the deployId subdomain to land on the bare control plane host.
        try {
          const u = new URL(parsed.origin)
          const parts = u.host.split(".")
          if (parts.length > 2) parts.shift()
          return `${u.protocol}//${parts.join(".")}`
        } catch {
          return parsed.origin
        }
      }
      return "https://pond.run"
    })()

    const url = `${apiBase}/api/public-deploys/${deployId}/source`
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`Fetch failed: ${res.status} (${url})`)
      if (res.status === 404) {
        console.error(
          `The deploy may not exist or may not be public. Capsules opt in via \`capsule({ public: true })\`.`,
        )
      }
      process.exit(1)
    }
    const body = (await res.json()) as {
      deployId: string
      title?: string
      description?: string
      files: Record<string, string>
    }
    if (!body.files || typeof body.files !== "object") {
      console.error("Source export was malformed.")
      process.exit(1)
    }

    let dirName = typeof args.name === "string" ? args.name : ""
    if (!dirName) {
      dirName = body.title ? slugify(body.title) : `fork-${deployId.slice(0, 8)}`
    }
    if (!SLUG_RE.test(dirName)) {
      console.error(`Invalid directory name: ${dirName}`)
      process.exit(1)
    }
    const dest = path.resolve(process.cwd(), dirName)
    if (fs.existsSync(dest)) {
      console.error(`Directory ${dirName} already exists`)
      process.exit(1)
    }
    fs.mkdirSync(dest, { recursive: true })

    // Drop in a generated session secret so the fork boots cleanly even if
    // the upstream didn't ship `.env.pond.server`.
    const envFile = path.join(dest, ".env.pond.server")
    if (!body.files[".env.pond.server"]) {
      fs.writeFileSync(envFile, `POND_SESSION_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 })
    }
    fs.writeFileSync(path.join(dest, ".gitignore"), "node_modules\n.pond\n")

    for (const [rel, content] of Object.entries(body.files)) {
      const abs = path.join(dest, rel)
      // belt-and-suspenders: refuse anything that would escape the dest dir
      if (!abs.startsWith(dest + path.sep)) continue
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }

    if (args.git) {
      try {
        execSync("git init", { cwd: dest, stdio: "ignore" })
        execSync("git add -A", { cwd: dest, stdio: "ignore" })
        execSync(`git commit -m "fork from ${deployId}"`, { cwd: dest, stdio: "ignore" })
      } catch {
        // git not installed — skip silently
      }
    }

    console.log(`\n  Forked ${deployId} into ${dirName}/`)
    if (body.title) console.log(`  Upstream title: ${body.title}`)
    console.log(`\n  Next steps:`)
    console.log(`    cd ${dirName}`)
    console.log(`    npm install`)
    console.log(`    npm run dev`)
    console.log()
  },
})
