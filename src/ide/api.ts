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
