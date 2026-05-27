import * as fs from "node:fs"
import * as path from "node:path"

// `.pond/deploy.json` is the local cache that ties this working directory to
// a specific deployId, the control plane that owns it (`apiUrl`), the public
// deploy URL (`url`), and the anonymous claim token. Every CLI command that
// targets a hosted deploy reads it.
export interface DeployRecord {
  deployId?: string
  apiUrl?: string
  url?: string
  claimToken?: string
  bundleHash?: string
  bundlePath?: string
  clientPath?: string
  port?: number
  timestamp?: string
  publicInspect?: boolean
  claimedAt?: string
  terminatesAt?: string
  expiresAt?: string
  [key: string]: unknown
}

export function deployRecordPath(cwd: string): string {
  return path.join(cwd, ".pond", "deploy.json")
}

// Hosts that mean "every interface I'm bound to" rather than an address a
// client can actually reach. If a control plane echoes one of these back as
// its public apiUrl (some versions of pond.run did, before 0.3.7) the value
// is unusable from outside the server process.
const BIND_SENTINEL_HOSTS = new Set(["0.0.0.0", "::", "[::]"])

function parseUrlOrNull(s: string): URL | null {
  try {
    return new URL(s)
  } catch {
    return null
  }
}

function isBindSentinel(host: string): boolean {
  const h = host.toLowerCase().split(":")[0]
  return BIND_SENTINEL_HOSTS.has(h) || BIND_SENTINEL_HOSTS.has(host.toLowerCase())
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase().split(":")[0]
  return h === "localhost" || h === "127.0.0.1" || h === "::1"
}

// Given a deploy URL like `https://46e8042f9ded40e8.pond.run`, derive the
// control plane URL by stripping the first DNS label. Returns null when the
// host has <= 2 labels (no parent zone we can guess) or the URL is invalid.
// This matches the heuristic `pond fork` already uses for the same problem.
export function deriveControlPlaneFromDeployUrl(deployUrl: string): string | null {
  const u = parseUrlOrNull(deployUrl)
  if (!u) return null
  const parts = u.host.split(".")
  if (parts.length <= 2) return null
  parts.shift()
  return `${u.protocol}//${parts.join(".")}`
}

export interface HealResult {
  healed: boolean
  before?: string
  after?: string
}

// Detect and repair the specific corruption pattern introduced by `pond
// claim` on 0.3.0–0.3.6: the saved `apiUrl` points at the control plane's
// internal bind address (e.g. `http://0.0.0.0:8787`) instead of the host the
// user actually reached. We only rewrite when (a) `apiUrl` parses to a bind
// sentinel AND (b) `url` is a non-loopback public host from which we can
// derive a sensible control plane address. Everything else is left alone so
// legitimate self-hosted setups bound to 0.0.0.0 over a loopback URL keep
// working.
export function healDeployRecord(record: DeployRecord): HealResult {
  if (typeof record.apiUrl !== "string" || typeof record.url !== "string") {
    return { healed: false }
  }
  const apiUrlParsed = parseUrlOrNull(record.apiUrl)
  if (!apiUrlParsed) return { healed: false }
  if (!isBindSentinel(apiUrlParsed.hostname)) return { healed: false }

  const publicUrlParsed = parseUrlOrNull(record.url)
  if (!publicUrlParsed) return { healed: false }
  if (isLoopback(publicUrlParsed.hostname)) return { healed: false }

  const recovered = deriveControlPlaneFromDeployUrl(record.url)
  if (!recovered) return { healed: false }

  const before = record.apiUrl
  record.apiUrl = recovered
  return { healed: true, before, after: recovered }
}

// Read .pond/deploy.json, apply self-heal if needed, persist the repair, and
// return the parsed record. Returns null when the file is absent or
// unreadable. The repair note is printed to stderr on the assumption that
// stdout is consumed programmatically by some readers (e.g. `pond env list`,
// `pond db dump`).
export function readDeployRecord(cwd: string): DeployRecord | null {
  const file = deployRecordPath(cwd)
  if (!fs.existsSync(file)) return null
  let record: DeployRecord
  try {
    record = JSON.parse(fs.readFileSync(file, "utf-8")) as DeployRecord
  } catch {
    return null
  }
  const result = healDeployRecord(record)
  if (result.healed) {
    try {
      fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 })
      try {
        fs.chmodSync(file, 0o600)
      } catch {
        // best-effort on platforms without chmod
      }
    } catch {
      // if we can't persist, the in-memory value is still corrected for this
      // process — the next run will retry
    }
    console.error(`pond: repaired .pond/deploy.json (apiUrl ${result.before} → ${result.after})`)
  }
  return record
}
