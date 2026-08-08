export interface FileEntry {
  path: string
  size: number
  mtime: string
}

export interface BuildOk {
  ok: true
  bundleBytes: number
  bundleHash: string
  durationMs: number
}

export interface BuildErr {
  ok: false
  errors: { file?: string; line?: number; column?: number; text: string }[]
  durationMs?: number
}

export type BuildResult = BuildOk | BuildErr

interface ApiOptions {
  deployId: string
  token: string
  isClaim: boolean
}

function headers(opts: ApiOptions, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra }
  if (opts.isClaim) h["x-pond-claim-token"] = opts.token
  else h["authorization"] = `Bearer ${opts.token}`
  return h
}

export async function fetchFiles(
  opts: ApiOptions,
): Promise<{ files: FileEntry[] } | { error: string; status: number }> {
  const r = await fetch(`/api/deploys/${opts.deployId}/files`, { headers: headers(opts) })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "request failed", status: r.status }
  return r.json()
}

export async function fetchFile(opts: ApiOptions, path: string): Promise<{ text: string } | { error: string }> {
  const r = await fetch(`/api/deploys/${opts.deployId}/files/${path}`, { headers: headers(opts) })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "request failed" }
  return { text: await r.text() }
}

export async function putFile(opts: ApiOptions, path: string, text: string): Promise<{ ok: true } | { error: string }> {
  const r = await fetch(`/api/deploys/${opts.deployId}/files/${path}`, {
    method: "PUT",
    headers: headers(opts, { "content-type": "text/plain" }),
    body: text,
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "save failed" }
  return { ok: true }
}

export async function deleteFile(opts: ApiOptions, path: string): Promise<{ ok: true } | { error: string }> {
  const r = await fetch(`/api/deploys/${opts.deployId}/files/${path}`, { method: "DELETE", headers: headers(opts) })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "delete failed" }
  return { ok: true }
}

export async function moveFile(opts: ApiOptions, from: string, to: string): Promise<{ ok: true } | { error: string }> {
  const r = await fetch(`/api/deploys/${opts.deployId}/files/move`, {
    method: "POST",
    headers: headers(opts, { "content-type": "application/json" }),
    body: JSON.stringify({ from, to }),
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "move failed" }
  return { ok: true }
}

export async function fetchEnv(opts: ApiOptions): Promise<{ entries: Record<string, string> } | { error: string }> {
  const r = await fetch(`/api/deploys/${opts.deployId}/env`, { headers: headers(opts) })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "request failed" }
  return r.json()
}

export async function putEnv(
  opts: ApiOptions,
  patch: Record<string, string>,
): Promise<{ entries: Record<string, string> } | { error: string }> {
  const r = await fetch(`/api/deploys/${opts.deployId}/env`, {
    method: "PUT",
    headers: headers(opts, { "content-type": "application/json" }),
    body: JSON.stringify({ entries: patch }),
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "save failed" }
  return r.json()
}

export async function deleteEnvKey(
  opts: ApiOptions,
  key: string,
): Promise<{ entries: Record<string, string> } | { error: string }> {
  const r = await fetch(`/api/deploys/${opts.deployId}/env/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: headers(opts),
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "delete failed" }
  return r.json()
}

export interface LogEntry {
  timestamp: string
  level: "info" | "error"
  message: string
  data?: unknown
}

export type LogStreamStatus = "live" | "reconnecting"

// Stream a deploy's logs through the CONTROL PLANE's owner-authed
// /api/deploys/:deployId/logs endpoint. The capsule's own SSE stream at
// /__pond/logs is unreachable from the IDE: it lives on the deploy origin
// (cross-origin from the apex), the custom claim/bearer headers trigger a
// CORS preflight the capsule can't answer, and owned deploys gate on a header
// the bearer flow never sends. Polling the same-origin control-plane endpoint
// sidesteps all three, works for claim-token AND bearer auth, and keeps
// working across redeploys (the capsule restarting doesn't tear down the
// connection). Exponential backoff + auto-reconnect on failure.
export function streamLogs(
  opts: ApiOptions,
  onEntry: (entry: LogEntry) => void,
  onError: (err: unknown) => void,
  onStatus?: (status: LogStreamStatus) => void,
): () => void {
  const ac = new AbortController()
  let lastTs = ""
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryMs = 1000

  const poll = async () => {
    try {
      const r = await fetch(`/api/deploys/${opts.deployId}/logs?limit=500`, {
        headers: headers(opts),
        signal: ac.signal,
      })
      if (!r.ok) {
        onError(`logs: ${r.status}`)
        return
      }
      const { entries } = (await r.json()) as { entries: LogEntry[] }
      for (const e of entries) {
        if (lastTs && e.timestamp <= lastTs) continue
        onEntry(e)
      }
      if (entries.length > 0) lastTs = entries[entries.length - 1].timestamp
      retryMs = 1000
      onStatus?.("live")
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return
      onError(err)
      onStatus?.("reconnecting")
    } finally {
      if (!ac.signal.aborted) {
        retryTimer = setTimeout(() => void poll(), retryMs)
        retryMs = Math.min(retryMs * 2, 10_000)
      }
    }
  }
  void poll()
  return () => {
    ac.abort()
    if (retryTimer) clearTimeout(retryTimer)
  }
}

export async function build(opts: ApiOptions): Promise<BuildResult> {
  const r = await fetch(`/api/deploys/${opts.deployId}/build`, { method: "POST", headers: headers(opts) })
  if (!r.ok) {
    return { ok: false, errors: [{ text: `HTTP ${r.status}` }] }
  }
  return r.json()
}

export function languageForPath(p: string): "typescript" | "json" | "markdown" | "plain" {
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript"
  if (p.endsWith(".json")) return "json"
  if (p.endsWith(".md")) return "markdown"
  return "plain"
}
