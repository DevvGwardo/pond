import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

export interface Credential {
  apiUrl: string
  username: string
  token: string
  isAdmin: boolean
  savedAt: string
}

interface CredentialsFile {
  credentials: Credential[]
}

function credentialsPath(): string {
  return path.join(os.homedir(), ".pond", "credentials.json")
}

function readFile(): CredentialsFile {
  const file = credentialsPath()
  if (!fs.existsSync(file)) return { credentials: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as CredentialsFile
    if (!Array.isArray(parsed.credentials)) return { credentials: [] }
    return parsed
  } catch {
    return { credentials: [] }
  }
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/$/, "")
}

export function loadCredentials(apiUrl: string): Credential | null {
  const key = normalizeApiUrl(apiUrl)
  const file = readFile()
  return file.credentials.find((c) => normalizeApiUrl(c.apiUrl) === key) ?? null
}

export function saveCredentials(cred: Omit<Credential, "savedAt"> & { savedAt?: string }): Credential {
  const file = readFile()
  const key = normalizeApiUrl(cred.apiUrl)
  const next: Credential = {
    apiUrl: key,
    username: cred.username,
    token: cred.token,
    isAdmin: cred.isAdmin,
    savedAt: cred.savedAt ?? new Date().toISOString(),
  }
  const filtered = file.credentials.filter((c) => normalizeApiUrl(c.apiUrl) !== key)
  filtered.push(next)
  const target = credentialsPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ credentials: filtered }, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(target, 0o600)
  } catch {
    // best effort
  }
  return next
}

export function credentialsFilePath(): string {
  return credentialsPath()
}
