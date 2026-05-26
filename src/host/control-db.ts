import Database from "better-sqlite3"
import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export interface UserRow {
  id: string
  username: string
  tokenHash: string
  isAdmin: number
  createdAt: string
}

export interface DeployQuota {
  deployId: string
  maxBundleBytes: number
  maxDiskBytes: number
  maxMemoryMb: number
}

export const DEFAULT_QUOTA: Omit<DeployQuota, "deployId"> = {
  maxBundleBytes: 64 * 1024 * 1024,
  maxDiskBytes: 512 * 1024 * 1024,
  maxMemoryMb: 256,
}

export interface ControlDb {
  hashToken(token: string): string
  createUser(username: string, isAdmin: boolean): { user: UserRow; token: string }
  findUserByTokenHash(tokenHash: string): UserRow | null
  findUserById(id: string): UserRow | null
  findUserByUsername(username: string): UserRow | null
  rotateUserToken(userId: string): string
  hasAnyUser(): boolean
  setDeployOwner(deployId: string, userId: string): void
  getDeployOwner(deployId: string): string | null
  listDeployIdsForUser(userId: string): string[]
  deleteDeployOwner(deployId: string): void
  getQuota(deployId: string): DeployQuota
  setQuota(deployId: string, patch: Partial<Omit<DeployQuota, "deployId">>): DeployQuota
  deleteQuota(deployId: string): void
  close(): void
}

export function openControlDb(dataDir: string): ControlDb {
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, "control.db")
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      tokenHash TEXT NOT NULL,
      isAdmin INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_tokenhash ON users(tokenHash);
    CREATE TABLE IF NOT EXISTS deploy_owners (
      deployId TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_owners_user ON deploy_owners(userId);
    CREATE TABLE IF NOT EXISTS deploy_quotas (
      deployId TEXT PRIMARY KEY,
      maxBundleBytes INTEGER,
      maxDiskBytes INTEGER,
      maxMemoryMb INTEGER
    );
  `)

  function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex")
  }

  const insertUser = db.prepare(
    "INSERT INTO users (id, username, tokenHash, isAdmin) VALUES (?, ?, ?, ?)"
  )
  const updateUserToken = db.prepare("UPDATE users SET tokenHash = ? WHERE id = ?")
  const selectByHash = db.prepare("SELECT id, username, tokenHash, isAdmin, createdAt FROM users WHERE tokenHash = ?")
  const selectById = db.prepare("SELECT id, username, tokenHash, isAdmin, createdAt FROM users WHERE id = ?")
  const selectByUsername = db.prepare(
    "SELECT id, username, tokenHash, isAdmin, createdAt FROM users WHERE username = ?"
  )
  const countUsers = db.prepare("SELECT COUNT(*) AS n FROM users")
  const insertOwner = db.prepare(
    "INSERT INTO deploy_owners (deployId, userId) VALUES (?, ?) ON CONFLICT(deployId) DO UPDATE SET userId = excluded.userId"
  )
  const selectOwner = db.prepare("SELECT userId FROM deploy_owners WHERE deployId = ?")
  const selectDeploysForUser = db.prepare("SELECT deployId FROM deploy_owners WHERE userId = ?")
  const deleteOwner = db.prepare("DELETE FROM deploy_owners WHERE deployId = ?")
  const selectQuota = db.prepare(
    "SELECT deployId, maxBundleBytes, maxDiskBytes, maxMemoryMb FROM deploy_quotas WHERE deployId = ?"
  )
  const upsertQuota = db.prepare(
    "INSERT INTO deploy_quotas (deployId, maxBundleBytes, maxDiskBytes, maxMemoryMb) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(deployId) DO UPDATE SET maxBundleBytes = excluded.maxBundleBytes, " +
      "maxDiskBytes = excluded.maxDiskBytes, maxMemoryMb = excluded.maxMemoryMb"
  )
  const deleteQuotaStmt = db.prepare("DELETE FROM deploy_quotas WHERE deployId = ?")

  return {
    hashToken,
    createUser(username, isAdmin) {
      const id = randomBytes(8).toString("hex")
      const token = randomBytes(32).toString("hex")
      const tokenHash = hashToken(token)
      insertUser.run(id, username, tokenHash, isAdmin ? 1 : 0)
      const user = selectById.get(id) as UserRow
      return { user, token }
    },
    findUserByTokenHash(tokenHash) {
      return (selectByHash.get(tokenHash) as UserRow | undefined) ?? null
    },
    findUserById(id) {
      return (selectById.get(id) as UserRow | undefined) ?? null
    },
    findUserByUsername(username) {
      return (selectByUsername.get(username) as UserRow | undefined) ?? null
    },
    rotateUserToken(userId) {
      const token = randomBytes(32).toString("hex")
      updateUserToken.run(hashToken(token), userId)
      return token
    },
    hasAnyUser() {
      const row = countUsers.get() as { n: number }
      return row.n > 0
    },
    setDeployOwner(deployId, userId) {
      insertOwner.run(deployId, userId)
    },
    getDeployOwner(deployId) {
      const row = selectOwner.get(deployId) as { userId: string } | undefined
      return row?.userId ?? null
    },
    listDeployIdsForUser(userId) {
      const rows = selectDeploysForUser.all(userId) as Array<{ deployId: string }>
      return rows.map((r) => r.deployId)
    },
    deleteDeployOwner(deployId) {
      deleteOwner.run(deployId)
    },
    getQuota(deployId) {
      const row = selectQuota.get(deployId) as
        | { deployId: string; maxBundleBytes: number | null; maxDiskBytes: number | null; maxMemoryMb: number | null }
        | undefined
      return {
        deployId,
        maxBundleBytes: row?.maxBundleBytes ?? DEFAULT_QUOTA.maxBundleBytes,
        maxDiskBytes: row?.maxDiskBytes ?? DEFAULT_QUOTA.maxDiskBytes,
        maxMemoryMb: row?.maxMemoryMb ?? DEFAULT_QUOTA.maxMemoryMb,
      }
    },
    setQuota(deployId, patch) {
      const cur = this.getQuota(deployId)
      const next: DeployQuota = {
        deployId,
        maxBundleBytes: patch.maxBundleBytes ?? cur.maxBundleBytes,
        maxDiskBytes: patch.maxDiskBytes ?? cur.maxDiskBytes,
        maxMemoryMb: patch.maxMemoryMb ?? cur.maxMemoryMb,
      }
      upsertQuota.run(deployId, next.maxBundleBytes, next.maxDiskBytes, next.maxMemoryMb)
      return next
    },
    deleteQuota(deployId) {
      deleteQuotaStmt.run(deployId)
    },
    close() {
      db.close()
    },
  }
}
