import { defineCommand } from "citty"
import { spawn } from "node:child_process"
import { listCredentials } from "../host/credentials.js"
import { readDeployRecord } from "../host/deploy-record.js"

function resolveApiUrl(arg: string | undefined): { apiUrl: string; source: string } | { error: string } {
  if (arg) {
    return { apiUrl: arg.replace(/\/$/, ""), source: "--api" }
  }

  const deploy = readDeployRecord(process.cwd())
  if (deploy?.apiUrl) {
    return { apiUrl: deploy.apiUrl.replace(/\/$/, ""), source: ".pond/deploy.json" }
  }

  const creds = listCredentials()
  if (creds.length === 1) {
    return { apiUrl: creds[0].apiUrl, source: `~/.pond/credentials.json (${creds[0].username})` }
  }
  if (creds.length === 0) {
    return {
      error:
        "No control plane to open. Pass --api <url>, run `pond login --api <url>`, or `cd` into a project with .pond/deploy.json.",
    }
  }
  const list = creds.map((c) => `  pond dashboard --api ${c.apiUrl}    # ${c.username}`).join("\n")
  return {
    error: `Multiple saved credentials. Pick one:\n${list}`,
  }
}

// Launch the platform browser. spawn's `error` event fires ASYNCHRONOUSLY for
// a missing binary (e.g. no xdg-open), so failure can only be reported through
// a promise — the old synchronous `return true` made the "could not launch"
// branch dead in exactly the case it exists for.
function openInBrowser(url: string): Promise<boolean> {
  const platform = process.platform
  let cmd: string
  let args: string[]
  if (platform === "darwin") {
    cmd = "open"
    args = [url]
  } else if (platform === "win32") {
    cmd = "cmd"
    // `start ""` ensures the first quoted arg isn't treated as the window title
    args = ["/c", "start", "", url]
  } else {
    cmd = "xdg-open"
    args = [url]
  }
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true })
    child.once("error", () => resolve(false))
    child.once("spawn", () => {
      child.unref()
      resolve(true)
    })
  })
}

export const dashboardCommand = defineCommand({
  meta: {
    name: "dashboard",
    description: "Open the pond dashboard for a control plane in your browser",
  },
  args: {
    api: {
      type: "string",
      description: "Control-plane URL (defaults to .pond/deploy.json or the only saved credential)",
      required: false,
    },
    "print-url": {
      type: "boolean",
      description: "Print the URL instead of opening a browser (use in headless/CI environments)",
      default: false,
    },
  },
  async run({ args }) {
    const apiArg = typeof args.api === "string" && args.api ? args.api : undefined
    const resolved = resolveApiUrl(apiArg)
    if ("error" in resolved) {
      console.error(resolved.error)
      process.exit(1)
    }

    const url = `${resolved.apiUrl}/dashboard`
    console.log(`Dashboard: ${url}`)
    console.log(`  (resolved from ${resolved.source})`)

    if (args["print-url"]) {
      return
    }

    const opened = await openInBrowser(url)
    if (!opened) {
      console.error(`Could not launch a browser. Open the URL above manually.`)
    }
  },
})
