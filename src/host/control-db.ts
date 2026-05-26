import Database from "better-sqlite3"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
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

export const ANONYMOUS_QUOTA: Omit<DeployQuota, "deployId"> = {
  maxBundleBytes: 16 * 1024 * 1024,
  maxDiskBytes: 128 * 1024 * 1024,
  maxMemoryMb: 128,
}

export interface AnonymousDeployRow {
  deployId: string
  claimTokenHash: string
  createdAt: string
  terminatesAt: string
  expiresAt: string
  terminated: number
}

export interface CustomDomainRow {
  subdomain: string
  deployId: string
  createdAt: string
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
  createAnonymous(
    deployId: string,
    claimToken: string,
    gracePeriodMs: number,
    retentionMs: number
  ): { terminatesAt: string; expiresAt: string }
  findAnonymous(deployId: string): AnonymousDeployRow | null
  markTerminated(deployId: string): void
  listForTermination(nowIso: string): string[]
  listForDeletion(nowIso: string): string[]
  promoteAnonymous(deployId: string, userId: string): void
  deleteAnonymous(deployId: string): void
  verifyAnonymousClaim(deployId: string, claimToken: string): boolean
  addDomain(subdomain: string, deployId: string): void
  findDomain(subdomain: string): CustomDomainRow | null
  listDomainsForDeploy(deployId: string): Array<{ subdomain: string; createdAt: string }>
  listDomainsForUser(userId: string): CustomDomainRow[]
  removeDomain(subdomain: string): void
  removeDomainsForDeploy(deployId: string): void
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
    CREATE TABLE IF NOT EXISTS anonymous_deploys (
      deployId TEXT PRIMARY KEY,
      claimTokenHash TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      terminatesAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      terminated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_anon_terminates ON anonymous_deploys(terminatesAt);
    CREATE INDEX IF NOT EXISTS idx_anon_expires ON anonymous_deploys(expiresAt);
    CREATE TABLE IF NOT EXISTS custom_domains (
      subdomain TEXT PRIMARY KEY,
      deployId TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_custom_domains_deploy ON custom_domains(deployId);
  `)

  // Lightweight migration for pre-Phase-5 DBs that only had (createdAt, expiresAt).
  const anonCols = (db.prepare("PRAGMA table_info(anonymous_deploys)").all() as Array<{ name: string }>).map(
    (c) => c.name
  )
  if (!anonCols.includes("terminatesAt")) {
    db.exec(`ALTER TABLE anonymous_deploys ADD COLUMN terminatesAt TEXT NOT NULL DEFAULT ''`)
    db.exec(`UPDATE anonymous_deploys SET terminatesAt = expiresAt WHERE terminatesAt = ''`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_anon_terminates ON anonymous_deploys(terminatesAt)`)
  }
  if (!anonCols.includes("terminated")) {
    db.exec(`ALTER TABLE anonymous_deploys ADD COLUMN terminated INTEGER NOT NULL DEFAULT 0`)
  }

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
  const insertAnon = db.prepare(
    "INSERT INTO anonymous_deploys (deployId, claimTokenHash, createdAt, terminatesAt, expiresAt, terminated) VALUES (?, ?, ?, ?, ?, 0)"
  )
  const selectAnon = db.prepare(
    "SELECT deployId, claimTokenHash, createdAt, terminatesAt, expiresAt, terminated FROM anonymous_deploys WHERE deployId = ?"
  )
  const deleteAnon = db.prepare("DELETE FROM anonymous_deploys WHERE deployId = ?")
  const markTerminatedStmt = db.prepare("UPDATE anonymous_deploys SET terminated = 1 WHERE deployId = ?")
  const selectForTermination = db.prepare(
    "SELECT deployId FROM anonymous_deploys WHERE terminated = 0 AND terminatesAt < ?"
  )
  const selectForDeletion = db.prepare("SELECT deployId FROM anonymous_deploys WHERE expiresAt < ?")
  const promoteTxn = db.transaction((deployId: string, userId: string) => {
    deleteAnon.run(deployId)
    insertOwner.run(deployId, userId)
  })
  const insertDomain = db.prepare(
    "INSERT INTO custom_domains (subdomain, deployId) VALUES (?, ?)"
  )
  const selectDomain = db.prepare(
    "SELECT subdomain, deployId, createdAt FROM custom_domains WHERE subdomain = ?"
  )
  const selectDomainsForDeploy = db.prepare(
    "SELECT subdomain, createdAt FROM custom_domains WHERE deployId = ? ORDER BY createdAt ASC"
  )
  const selectDomainsForUser = db.prepare(
    "SELECT cd.subdomain AS subdomain, cd.deployId AS deployId, cd.createdAt AS createdAt " +
      "FROM custom_domains cd JOIN deploy_owners do ON do.deployId = cd.deployId " +
      "WHERE do.userId = ? ORDER BY cd.createdAt ASC"
  )
  const deleteDomain = db.prepare("DELETE FROM custom_domains WHERE subdomain = ?")
  const deleteDomainsForDeployStmt = db.prepare("DELETE FROM custom_domains WHERE deployId = ?")

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
    createAnonymous(deployId, claimToken, gracePeriodMs, retentionMs) {
      const now = new Date()
      const terminatesAt = new Date(now.getTime() + gracePeriodMs).toISOString()
      const expiresAt = new Date(now.getTime() + retentionMs).toISOString()
      insertAnon.run(deployId, hashToken(claimToken), now.toISOString(), terminatesAt, expiresAt)
      return { terminatesAt, expiresAt }
    },
    findAnonymous(deployId) {
      return (selectAnon.get(deployId) as AnonymousDeployRow | undefined) ?? null
    },
    markTerminated(deployId) {
      markTerminatedStmt.run(deployId)
    },
    listForTermination(nowIso) {
      const rows = selectForTermination.all(nowIso) as Array<{ deployId: string }>
      return rows.map((r) => r.deployId)
    },
    listForDeletion(nowIso) {
      const rows = selectForDeletion.all(nowIso) as Array<{ deployId: string }>
      return rows.map((r) => r.deployId)
    },
    promoteAnonymous(deployId, userId) {
      promoteTxn(deployId, userId)
    },
    deleteAnonymous(deployId) {
      deleteAnon.run(deployId)
    },
    verifyAnonymousClaim(deployId, claimToken) {
      const row = selectAnon.get(deployId) as AnonymousDeployRow | undefined
      if (!row) return false
      const provided = Buffer.from(hashToken(claimToken))
      const stored = Buffer.from(row.claimTokenHash)
      if (provided.length !== stored.length) return false
      return timingSafeEqual(provided, stored)
    },
    addDomain(subdomain, deployId) {
      insertDomain.run(subdomain, deployId)
    },
    findDomain(subdomain) {
      return (selectDomain.get(subdomain) as CustomDomainRow | undefined) ?? null
    },
    listDomainsForDeploy(deployId) {
      return selectDomainsForDeploy.all(deployId) as Array<{ subdomain: string; createdAt: string }>
    },
    listDomainsForUser(userId) {
      return selectDomainsForUser.all(userId) as CustomDomainRow[]
    },
    removeDomain(subdomain) {
      deleteDomain.run(subdomain)
    },
    removeDomainsForDeploy(deployId) {
      deleteDomainsForDeployStmt.run(deployId)
    },
    close() {
      db.close()
    },
  }
}
