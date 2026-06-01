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
  // Percent of a single CPU the worker may use, enforced via cgroup cpu.max
  // when the host runs with --capsule-cgroup-root. 100 = one full core.
  maxCpuPercent: number
}

/** Grace window during which a freshly-rotated user's previous token still authenticates. */
export const ROTATE_GRACE_MS = 5 * 60 * 1000

export const DEFAULT_QUOTA: Omit<DeployQuota, "deployId"> = {
  maxBundleBytes: 64 * 1024 * 1024,
  maxDiskBytes: 512 * 1024 * 1024,
  maxMemoryMb: 256,
  maxCpuPercent: 50,
}

export const ANONYMOUS_QUOTA: Omit<DeployQuota, "deployId"> = {
  maxBundleBytes: 16 * 1024 * 1024,
  maxDiskBytes: 128 * 1024 * 1024,
  maxMemoryMb: 128,
  maxCpuPercent: 25,
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

export interface AuditLogRow {
  id: number
  ts: string
  actor: string
  action: string
  targetDeployId: string | null
  targetUserId: string | null
  metadata: string | null
}

export interface AuditEntry {
  actor: string
  action: string
  targetDeployId?: string | null
  targetUserId?: string | null
  metadata?: Record<string, unknown> | null
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
    retentionMs: number,
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
  countDomainsForUser(userId: string): number
  removeDomain(subdomain: string): void
  removeDomainsForDeploy(deployId: string): void
  /** Per-deploy egress credential + allowlist for the egress proxy. */
  setEgress(deployId: string, secretHash: string, allowlist: string[]): void
  getEgress(deployId: string): { secretHash: string; allowlist: string[] } | null
  setEgressAllowlist(deployId: string, allowlist: string[]): void
  deleteEgress(deployId: string): void
  appendAudit(entry: AuditEntry): void
  listAudit(opts?: { limit?: number; sinceTs?: string }): AuditLogRow[]
  /** Aggregate deployment counts (from deploy.create audit events): rolling
   *  24h / 7d windows, all-time total, and a per-day breakdown for the last 7 days. */
  deployStats(): {
    last24h: number
    last7d: number
    total: number
    daily: Array<{ day: string; count: number }>
  }
  /**
   * Records an attempt and returns true if it is within the limit for the
   * (scope, key) pair over the trailing `windowMs` window. Atomically prunes
   * entries older than the window. False means the limit is already exhausted
   * — no attempt is recorded in that case.
   */
  rateAllow(scope: string, key: string, windowMs: number, limit: number): boolean
  /** Removes rate-limit entries older than `olderThanMs` from now (across all scopes). */
  pruneRateLimits(olderThanMs: number): number
  /**
   * Records one request (and, when `isMutation`, one mutation) against a
   * deploy's rolling daily quota. Returns ok=false WITHOUT incrementing when the
   * relevant limit is already reached, so a denied request doesn't consume
   * quota. `day` is a UTC date key (YYYY-MM-DD). A limit <= 0 disables that axis.
   */
  consumeDailyUsage(
    deployId: string,
    day: string,
    isMutation: boolean,
    reqLimit: number,
    mutLimit: number,
  ): { ok: boolean; kind?: "request" | "mutation" }
  /** Removes daily-usage rows for days strictly before `beforeDay` (YYYY-MM-DD). */
  pruneDailyUsage(beforeDay: string): number
  /**
   * Write a clean, transactionally-consistent snapshot of the control DB to
   * `destPath` via `VACUUM INTO`. Unlike copying the file, this captures a
   * coherent state even while the DB is in use (open WAL), so an operator cron
   * can snapshot a live host without quiescing it.
   */
  backup(destPath: string): void
  close(): void
}

/**
 * Verify that a SQLite file at `file` is a usable database, not merely one with
 * the right magic header. Opens it read-only, runs `PRAGMA integrity_check`, and
 * confirms the schema is queryable. Used to gate a restore: a candidate that
 * passes the 16-byte header check can still be truncated/corrupt, and swapping
 * it in would brick the host on next boot. Returns the failure reason instead of
 * throwing so callers can turn it into a clean 4xx.
 */
export function validateSqliteFile(file: string): { ok: true } | { ok: false; error: string } {
  let probe: Database.Database | null = null
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true })
    const result = probe.pragma("integrity_check", { simple: true })
    if (result !== "ok") return { ok: false, error: `integrity_check failed: ${String(result)}` }
    // Confirm the catalog itself is readable — a corrupt page can pass
    // integrity_check on an empty db yet fail real queries.
    probe.prepare("SELECT name FROM sqlite_master LIMIT 1").get()
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  } finally {
    try {
      probe?.close()
    } catch {
      // best effort
    }
  }
}

export function openControlDb(dataDir: string): ControlDb {
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, "control.db")
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  // The control DB is the source of truth for users, ownership, quotas and the
  // audit log — an acknowledged write must survive an OS crash. FULL is SQLite's
  // default, but WAL deployments often drop to NORMAL (which only fsyncs at
  // checkpoints); pin it FULL explicitly so the durability of this DB can't be
  // weakened by a future pragma/journal-mode change. This DB sees low write
  // volume, so the extra fsync-per-commit cost is irrelevant.
  db.pragma("synchronous = FULL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      tokenHash TEXT NOT NULL,
      isAdmin INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now')),
      previousTokenHash TEXT,
      previousTokenExpiresAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_tokenhash ON users(tokenHash);
    CREATE INDEX IF NOT EXISTS idx_users_prev_tokenhash ON users(previousTokenHash);
    CREATE TABLE IF NOT EXISTS deploy_owners (
      deployId TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_owners_user ON deploy_owners(userId);
    CREATE TABLE IF NOT EXISTS deploy_quotas (
      deployId TEXT PRIMARY KEY,
      maxBundleBytes INTEGER,
      maxDiskBytes INTEGER,
      maxMemoryMb INTEGER,
      maxCpuPercent INTEGER
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
    CREATE TABLE IF NOT EXISTS deploy_egress (
      deployId TEXT PRIMARY KEY,
      secretHash TEXT NOT NULL,
      allowlist TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      targetDeployId TEXT,
      targetUserId TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
    CREATE INDEX IF NOT EXISTS idx_audit_log_target_deploy ON audit_log(targetDeployId);
    CREATE TABLE IF NOT EXISTS rate_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_scope_key_ts ON rate_limits(scope, key, ts);
    CREATE INDEX IF NOT EXISTS idx_rate_limits_ts ON rate_limits(ts);
    CREATE TABLE IF NOT EXISTS deploy_usage (
      deployId TEXT NOT NULL,
      day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      mutations INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (deployId, day)
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_usage_day ON deploy_usage(day);
  `)

  // Lightweight migration for pre-Phase-5 DBs that only had (createdAt, expiresAt).
  const anonCols = (db.prepare("PRAGMA table_info(anonymous_deploys)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  )
  if (!anonCols.includes("terminatesAt")) {
    db.exec(`ALTER TABLE anonymous_deploys ADD COLUMN terminatesAt TEXT NOT NULL DEFAULT ''`)
    db.exec(`UPDATE anonymous_deploys SET terminatesAt = expiresAt WHERE terminatesAt = ''`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_anon_terminates ON anonymous_deploys(terminatesAt)`)
  }
  if (!anonCols.includes("terminated")) {
    db.exec(`ALTER TABLE anonymous_deploys ADD COLUMN terminated INTEGER NOT NULL DEFAULT 0`)
  }

  // Migrate pre-CPU-quota DBs that lack the maxCpuPercent column.
  const quotaCols = (db.prepare("PRAGMA table_info(deploy_quotas)").all() as Array<{ name: string }>).map((c) => c.name)
  if (!quotaCols.includes("maxCpuPercent")) {
    db.exec(`ALTER TABLE deploy_quotas ADD COLUMN maxCpuPercent INTEGER`)
  }

  // Migrate pre-grace-window DBs to add previous-token columns on users.
  const userCols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name)
  if (!userCols.includes("previousTokenHash")) {
    db.exec(`ALTER TABLE users ADD COLUMN previousTokenHash TEXT`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_prev_tokenhash ON users(previousTokenHash)`)
  }
  if (!userCols.includes("previousTokenExpiresAt")) {
    db.exec(`ALTER TABLE users ADD COLUMN previousTokenExpiresAt TEXT`)
  }

  function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex")
  }

  const insertUser = db.prepare("INSERT INTO users (id, username, tokenHash, isAdmin) VALUES (?, ?, ?, ?)")
  const updateUserToken = db.prepare(
    "UPDATE users SET tokenHash = ?, previousTokenHash = ?, previousTokenExpiresAt = ? WHERE id = ?",
  )
  const selectByCurrentHash = db.prepare(
    "SELECT id, username, tokenHash, isAdmin, createdAt FROM users WHERE tokenHash = ?",
  )
  const selectByPreviousHash = db.prepare(
    "SELECT id, username, tokenHash, isAdmin, createdAt, previousTokenExpiresAt FROM users WHERE previousTokenHash = ?",
  )
  const selectById = db.prepare("SELECT id, username, tokenHash, isAdmin, createdAt FROM users WHERE id = ?")
  const selectByUsername = db.prepare(
    "SELECT id, username, tokenHash, isAdmin, createdAt FROM users WHERE username = ?",
  )
  const countUsers = db.prepare("SELECT COUNT(*) AS n FROM users")
  const insertOwner = db.prepare(
    "INSERT INTO deploy_owners (deployId, userId) VALUES (?, ?) ON CONFLICT(deployId) DO UPDATE SET userId = excluded.userId",
  )
  const selectOwner = db.prepare("SELECT userId FROM deploy_owners WHERE deployId = ?")
  const selectDeploysForUser = db.prepare("SELECT deployId FROM deploy_owners WHERE userId = ?")
  const deleteOwner = db.prepare("DELETE FROM deploy_owners WHERE deployId = ?")
  const selectQuota = db.prepare(
    "SELECT deployId, maxBundleBytes, maxDiskBytes, maxMemoryMb, maxCpuPercent FROM deploy_quotas WHERE deployId = ?",
  )
  const upsertQuota = db.prepare(
    "INSERT INTO deploy_quotas (deployId, maxBundleBytes, maxDiskBytes, maxMemoryMb, maxCpuPercent) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(deployId) DO UPDATE SET maxBundleBytes = excluded.maxBundleBytes, " +
      "maxDiskBytes = excluded.maxDiskBytes, maxMemoryMb = excluded.maxMemoryMb, maxCpuPercent = excluded.maxCpuPercent",
  )
  const deleteQuotaStmt = db.prepare("DELETE FROM deploy_quotas WHERE deployId = ?")
  const insertAnon = db.prepare(
    "INSERT INTO anonymous_deploys (deployId, claimTokenHash, createdAt, terminatesAt, expiresAt, terminated) VALUES (?, ?, ?, ?, ?, 0)",
  )
  const selectAnon = db.prepare(
    "SELECT deployId, claimTokenHash, createdAt, terminatesAt, expiresAt, terminated FROM anonymous_deploys WHERE deployId = ?",
  )
  const deleteAnon = db.prepare("DELETE FROM anonymous_deploys WHERE deployId = ?")
  const markTerminatedStmt = db.prepare("UPDATE anonymous_deploys SET terminated = 1 WHERE deployId = ?")
  const selectForTermination = db.prepare(
    "SELECT deployId FROM anonymous_deploys WHERE terminated = 0 AND terminatesAt < ?",
  )
  const selectForDeletion = db.prepare("SELECT deployId FROM anonymous_deploys WHERE expiresAt < ?")
  const promoteTxn = db.transaction((deployId: string, userId: string) => {
    deleteAnon.run(deployId)
    insertOwner.run(deployId, userId)
  })
  const insertDomain = db.prepare("INSERT INTO custom_domains (subdomain, deployId) VALUES (?, ?)")
  const selectDomain = db.prepare("SELECT subdomain, deployId, createdAt FROM custom_domains WHERE subdomain = ?")
  const selectDomainsForDeploy = db.prepare(
    "SELECT subdomain, createdAt FROM custom_domains WHERE deployId = ? ORDER BY createdAt ASC",
  )
  const selectDomainsForUser = db.prepare(
    "SELECT cd.subdomain AS subdomain, cd.deployId AS deployId, cd.createdAt AS createdAt " +
      "FROM custom_domains cd JOIN deploy_owners do ON do.deployId = cd.deployId " +
      "WHERE do.userId = ? ORDER BY cd.createdAt ASC",
  )
  const countDomainsForUserStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM custom_domains cd JOIN deploy_owners do ON do.deployId = cd.deployId WHERE do.userId = ?",
  )
  const deleteDomain = db.prepare("DELETE FROM custom_domains WHERE subdomain = ?")
  const deleteDomainsForDeployStmt = db.prepare("DELETE FROM custom_domains WHERE deployId = ?")
  const pruneRateForKey = db.prepare("DELETE FROM rate_limits WHERE scope = ? AND key = ? AND ts < ?")
  const pruneRateAll = db.prepare("DELETE FROM rate_limits WHERE ts < ?")
  const countRateForKey = db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE scope = ? AND key = ? AND ts >= ?")
  const insertRate = db.prepare("INSERT INTO rate_limits (scope, key, ts) VALUES (?, ?, ?)")
  const rateAllowTxn = db.transaction((scope: string, key: string, windowMs: number, limit: number) => {
    const now = Date.now()
    const cutoff = now - windowMs
    pruneRateForKey.run(scope, key, cutoff)
    const count = (countRateForKey.get(scope, key, cutoff) as { n: number }).n
    if (count >= limit) return false
    insertRate.run(scope, key, now)
    return true
  })

  const getUsage = db.prepare("SELECT requests, mutations FROM deploy_usage WHERE deployId = ? AND day = ?")
  const bumpUsage = db.prepare(
    "INSERT INTO deploy_usage (deployId, day, requests, mutations) VALUES (?, ?, 1, ?) " +
      "ON CONFLICT(deployId, day) DO UPDATE SET requests = requests + 1, mutations = mutations + excluded.mutations",
  )
  const pruneUsageStmt = db.prepare("DELETE FROM deploy_usage WHERE day < ?")
  const consumeDailyUsageTxn = db.transaction(
    (deployId: string, day: string, isMutation: boolean, reqLimit: number, mutLimit: number) => {
      const row = getUsage.get(deployId, day) as { requests: number; mutations: number } | undefined
      const requests = row?.requests ?? 0
      const mutations = row?.mutations ?? 0
      if (reqLimit > 0 && requests >= reqLimit) return { ok: false, kind: "request" as const }
      if (isMutation && mutLimit > 0 && mutations >= mutLimit) return { ok: false, kind: "mutation" as const }
      bumpUsage.run(deployId, day, isMutation ? 1 : 0)
      return { ok: true }
    },
  )

  const insertAudit = db.prepare(
    "INSERT INTO audit_log (actor, action, targetDeployId, targetUserId, metadata) VALUES (?, ?, ?, ?, ?)",
  )
  const selectAuditRecent = db.prepare(
    "SELECT id, ts, actor, action, targetDeployId, targetUserId, metadata FROM audit_log ORDER BY id DESC LIMIT ?",
  )
  const selectAuditSince = db.prepare(
    "SELECT id, ts, actor, action, targetDeployId, targetUserId, metadata FROM audit_log WHERE ts >= ? ORDER BY id DESC LIMIT ?",
  )

  // Deployment counts derived from deploy.create audit events (which persist
  // even after a deploy expires/is deleted, so the windows reflect actual
  // deploy activity, not the current resident set). The `?` binds a SQLite
  // datetime modifier like '-1 day' / '-7 days'.
  const countDeploysSince = db.prepare(
    "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'deploy.create' AND ts >= datetime('now', ?)",
  )
  const countDeploysTotal = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'deploy.create'")
  const deploysPerDay = db.prepare(
    "SELECT date(ts) AS day, COUNT(*) AS c FROM audit_log WHERE action = 'deploy.create' AND ts >= datetime('now', '-30 days') GROUP BY day ORDER BY day",
  )

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
      const current = selectByCurrentHash.get(tokenHash) as UserRow | undefined
      if (current) return current
      const prev = selectByPreviousHash.get(tokenHash) as
        | (UserRow & { previousTokenExpiresAt: string | null })
        | undefined
      if (!prev) return null
      if (!prev.previousTokenExpiresAt) return null
      if (Date.parse(prev.previousTokenExpiresAt) < Date.now()) return null
      const { previousTokenExpiresAt: _unused, ...row } = prev
      return row
    },
    findUserById(id) {
      return (selectById.get(id) as UserRow | undefined) ?? null
    },
    findUserByUsername(username) {
      return (selectByUsername.get(username) as UserRow | undefined) ?? null
    },
    rotateUserToken(userId) {
      const current = selectById.get(userId) as UserRow | undefined
      const oldHash = current?.tokenHash ?? null
      const graceExpiresAt = new Date(Date.now() + ROTATE_GRACE_MS).toISOString()
      const token = randomBytes(32).toString("hex")
      updateUserToken.run(hashToken(token), oldHash, graceExpiresAt, userId)
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
        | {
            deployId: string
            maxBundleBytes: number | null
            maxDiskBytes: number | null
            maxMemoryMb: number | null
            maxCpuPercent: number | null
          }
        | undefined
      return {
        deployId,
        maxBundleBytes: row?.maxBundleBytes ?? DEFAULT_QUOTA.maxBundleBytes,
        maxDiskBytes: row?.maxDiskBytes ?? DEFAULT_QUOTA.maxDiskBytes,
        maxMemoryMb: row?.maxMemoryMb ?? DEFAULT_QUOTA.maxMemoryMb,
        maxCpuPercent: row?.maxCpuPercent ?? DEFAULT_QUOTA.maxCpuPercent,
      }
    },
    setQuota(deployId, patch) {
      const cur = this.getQuota(deployId)
      const next: DeployQuota = {
        deployId,
        maxBundleBytes: patch.maxBundleBytes ?? cur.maxBundleBytes,
        maxDiskBytes: patch.maxDiskBytes ?? cur.maxDiskBytes,
        maxMemoryMb: patch.maxMemoryMb ?? cur.maxMemoryMb,
        maxCpuPercent: patch.maxCpuPercent ?? cur.maxCpuPercent,
      }
      upsertQuota.run(deployId, next.maxBundleBytes, next.maxDiskBytes, next.maxMemoryMb, next.maxCpuPercent)
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
    countDomainsForUser(userId) {
      return (countDomainsForUserStmt.get(userId) as { n: number }).n
    },
    removeDomain(subdomain) {
      deleteDomain.run(subdomain)
    },
    removeDomainsForDeploy(deployId) {
      deleteDomainsForDeployStmt.run(deployId)
    },
    setEgress(deployId, secretHash, allowlist) {
      db.prepare(
        "INSERT INTO deploy_egress (deployId, secretHash, allowlist) VALUES (?, ?, ?) " +
          "ON CONFLICT(deployId) DO UPDATE SET secretHash = excluded.secretHash, allowlist = excluded.allowlist",
      ).run(deployId, secretHash, JSON.stringify(allowlist))
    },
    getEgress(deployId) {
      const row = db.prepare("SELECT secretHash, allowlist FROM deploy_egress WHERE deployId = ?").get(deployId) as
        | { secretHash: string; allowlist: string }
        | undefined
      if (!row) return null
      let allowlist: string[] = []
      try {
        const parsed = JSON.parse(row.allowlist)
        if (Array.isArray(parsed)) allowlist = parsed.filter((x): x is string => typeof x === "string")
      } catch {
        // corrupt JSON → treat as empty allowlist (deny-all), never throw
      }
      return { secretHash: row.secretHash, allowlist }
    },
    setEgressAllowlist(deployId, allowlist) {
      db.prepare("UPDATE deploy_egress SET allowlist = ? WHERE deployId = ?").run(JSON.stringify(allowlist), deployId)
    },
    deleteEgress(deployId) {
      db.prepare("DELETE FROM deploy_egress WHERE deployId = ?").run(deployId)
    },
    appendAudit(entry) {
      insertAudit.run(
        entry.actor,
        entry.action,
        entry.targetDeployId ?? null,
        entry.targetUserId ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      )
    },
    deployStats() {
      const last24h = (countDeploysSince.get("-1 day") as { c: number }).c
      const last7d = (countDeploysSince.get("-7 days") as { c: number }).c
      const total = (countDeploysTotal.get() as { c: number }).c
      const daily = (deploysPerDay.all() as Array<{ day: string; c: number }>).map((r) => ({
        day: r.day,
        count: r.c,
      }))
      return { last24h, last7d, total, daily }
    },
    rateAllow(scope, key, windowMs, limit) {
      return rateAllowTxn(scope, key, windowMs, limit) as boolean
    },
    pruneRateLimits(olderThanMs) {
      const cutoff = Date.now() - olderThanMs
      const info = pruneRateAll.run(cutoff)
      return info.changes
    },
    consumeDailyUsage(deployId, day, isMutation, reqLimit, mutLimit) {
      return consumeDailyUsageTxn(deployId, day, isMutation, reqLimit, mutLimit) as {
        ok: boolean
        kind?: "request" | "mutation"
      }
    },
    pruneDailyUsage(beforeDay) {
      return pruneUsageStmt.run(beforeDay).changes
    },
    backup(destPath) {
      // `VACUUM INTO` writes a consistent snapshot in one SQL statement. It takes
      // a path string literal, not a bound parameter, so single-quotes in the
      // (operator-supplied, admin-route-only) path are escaped. This is the same
      // snapshot mechanism the per-capsule backup endpoint uses.
      const sql = `VACUUM INTO '${destPath.replace(/'/g, "''")}'`
      db.exec(sql)
    },
    listAudit(opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000)
      const rows = (
        opts?.sinceTs ? selectAuditSince.all(opts.sinceTs, limit) : selectAuditRecent.all(limit)
      ) as AuditLogRow[]
      return rows
    },
    close() {
      db.close()
    },
  }
}
