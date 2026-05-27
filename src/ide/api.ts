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

export function streamLogs(
  deployUrl: string,
  opts: ApiOptions,
  onEntry: (entry: LogEntry) => void,
  onError: (err: unknown) => void,
): () => void {
  // The capsule's SSE log stream is served at /__pond/logs on the deploy origin,
  // not the control plane. We pass the same claim/bearer token via the standard
  // header — anonymous deploys gate on `x-pond-claim-token`, owned ones on Bearer.
  const ac = new AbortController()
  void (async () => {
    try {
      const res = await fetch(`${deployUrl.replace(/\/$/, "")}/__pond/logs`, {
        headers: headers(opts),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        onError(`logs: ${res.status}`)
        return
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split("\n\n")
        buf = parts.pop() ?? ""
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "))
          if (!line) continue
          try {
            onEntry(JSON.parse(line.slice(6)) as LogEntry)
          } catch {
            // skip malformed
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") onError(err)
    }
  })()
  return () => ac.abort()
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
