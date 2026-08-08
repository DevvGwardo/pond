// Shared plumbing for CLI commands: clean failure output (a one-line message +
// exit 1 instead of a raw stack dump from citty's runMain), the
// local/dev-server/remote-deploy target resolution matrix, and common flag
// definitions. Keep command files focused on their own logic.
import { renderUsage } from "citty"
import { readDeployRecord } from "../host/deploy-record.js"

// Print a one-line error and exit non-zero. Command `run()` bodies must use
// this for EXPECTED failures (bad input, request errors): citty's runMain
// prints the full stack trace for plain thrown errors, which turns a "Request
// failed: 500" into a wall of undici internals. Unexpected errors (real bugs)
// are still rethrown — a stack trace there is the bug report.
export function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// Format an HTTP failure with the status, target URL, and a capped body
// snippet so the user can act on it (a bare "Request failed: 500" gives them
// nothing to go on).
export async function httpError(res: Response, context: string): Promise<never> {
  let snippet = ""
  try {
    const text = (await res.text()).trim()
    if (text) snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    // body already consumed / unreadable — status + URL still help
  }
  const where = res.url ? ` ${res.url}` : ""
  return fail(`${context} failed: HTTP ${res.status}${where}${snippet ? ` — ${snippet}` : ""}`)
}

export interface ResolvedTarget {
  baseUrl: string
  headers: Record<string, string>
  source: "explicit" | "auto-remote" | "local"
}

// Decide whether to hit the local dev server or the deploy in .pond/
// deploy.json.
//
//   --local true              → localhost:<port> (force)
//   target is http(s) URL     → that URL
//   target matches deploy.id  → deploy.url + claim-token header
//   target is unset, deploy
//     has remote url+token   → auto-remote (the common case from a deployed
//                              project — was previously a silent localhost
//                              call that confused users)
//   otherwise                 → localhost:<port>
export function resolveTarget(target: string | undefined, port: string, local: boolean): ResolvedTarget {
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
    fail(`Unknown deploy target: ${target} (expected a full URL or the deployId in .pond/deploy.json)`)
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
export function noticeAutoRemoteOnce(resolved: ResolvedTarget) {
  if (resolved.source !== "auto-remote" || autoRemoteNoticeShown) return
  autoRemoteNoticeShown = true
  console.error(`→ Targeting ${resolved.baseUrl}  (pass --local for the dev server)`)
}

// Walk `err.cause` and any AggregateError.errors[] looking for a matching
// error code. Node's undici uses happy-eyeballs on dual-stack hosts (`localhost`
// → IPv4 + IPv6 in parallel); when both families refuse, `err.cause` is an
// AggregateError, not a single Error with `.code`. Without this walker the
// caller's friendly "is the capsule running?" message never fires and the
// raw undici stack leaks. Bounded depth so a malformed chain can't loop.
export function hasErrorCode(err: unknown, target: string, depth = 0): boolean {
  if (depth > 5 || err == null) return false
  if (typeof err === "object") {
    const e = err as { code?: unknown; cause?: unknown; errors?: unknown }
    if (typeof e.code === "string" && e.code === target) return true
    if (Array.isArray(e.errors)) {
      for (const sub of e.errors) {
        if (hasErrorCode(sub, target, depth + 1)) return true
      }
    }
    if (e.cause && e.cause !== err) {
      if (hasErrorCode(e.cause, target, depth + 1)) return true
    }
  }
  return false
}

// User-facing fetch wrapper: a refused connection (host down, wrong --api)
// becomes a one-line error instead of a raw undici stack dump via citty.
export async function fetchOrFail(url: string, init?: RequestInit, hint?: string): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    if (hasErrorCode(err, "ECONNREFUSED")) {
      fail(`Could not reach ${url} — ${hint ?? "is the control plane running?"}`)
    }
    fail(`Request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Shared --local flag for commands that target a capsule (db/inspect/logs).
export const LOCAL_FLAG = {
  type: "boolean" as const,
  default: false,
  description: "Force localhost:<port> even if .pond/deploy.json points at a remote deploy",
}

// citty throws E_NO_COMMAND on bare subcommand-group invocations (e.g. plain
// `pond db`), which renders help AND exits 1 with "ERROR No command
// specified". To match git/npm behavior — print help cleanly, exit 0 — every
// subcommand group sets this as its `run`. It also runs after a subcommand
// fires, so we no-op when args._ already has a positional.
export async function showGroupUsageIfBare({ args, cmd }: { args: Record<string, unknown>; cmd: unknown }) {
  const positionals = (args._ as string[] | undefined) ?? []
  if (positionals.length > 0) return
  console.log(await renderUsage(cmd as Parameters<typeof renderUsage>[0]))
}

// Parse a CLI port flag with a loud failure instead of letting NaN flow into
// a listener. Empty string falls back (matches the historical behavior where
// an unset --port on `pond start` reads PORT/deploy.json).
export function parsePort(raw: string | undefined, fallback: number, flagName = "--port"): number {
  if (!raw || raw.trim() === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    fail(`${flagName} must be a number between 1 and 65535, got "${raw}"`)
  }
  return n
}
