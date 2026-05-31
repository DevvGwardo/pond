// Unit tests for the control-DB durability helpers added for P0 item 3:
// a consistent backup() snapshot and a validate-before-swap restore guard.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"

import { openControlDb, validateSqliteFile } from "../src/host/control-db.js"

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

test("validateSqliteFile accepts a real, queryable database", () => {
  const dir = tmp("pond-validate-ok-")
  try {
    const file = path.join(dir, "good.db")
    const db = new Database(file)
    db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").run()
    db.prepare("INSERT INTO t (v) VALUES (?)").run("x")
    db.close()
    const r = validateSqliteFile(file)
    assert.equal(r.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("validateSqliteFile rejects a file that only LOOKS like SQLite", () => {
  const dir = tmp("pond-validate-bad-")
  try {
    // 16-byte SQLite magic header followed by garbage — exactly the payload that
    // sails past the restore endpoint's header check but is not a usable db.
    const file = path.join(dir, "corrupt.db")
    const magic = Buffer.from("SQLite format 3 ", "latin1")
    writeFileSync(file, Buffer.concat([magic, Buffer.alloc(2000, 0x7f)]))
    const r = validateSqliteFile(file)
    assert.equal(r.ok, false)
    assert.ok(typeof r.error === "string" && r.error.length > 0, "expected a failure reason")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("validateSqliteFile rejects a missing file", () => {
  const r = validateSqliteFile("/nonexistent/path/to/missing.db")
  assert.equal(r.ok, false)
})

test("control-db backup() writes a consistent, queryable snapshot", () => {
  const dir = tmp("pond-control-backup-")
  try {
    const controlDb = openControlDb(dir)
    const { user } = controlDb.createUser("alice", true)
    const dest = path.join(dir, "snapshot.db")
    controlDb.backup(dest)
    controlDb.close()

    assert.ok(existsSync(dest), "backup file should exist")
    assert.ok(statSync(dest).size > 0, "backup file should be non-empty")

    // The snapshot must pass the same validation a restore would run...
    assert.equal(validateSqliteFile(dest).ok, true)

    // ...and actually contain the committed data.
    const snap = new Database(dest, { readonly: true })
    try {
      const row = snap.prepare("SELECT username FROM users WHERE id = ?").get(user.id)
      assert.equal(row.username, "alice")
    } finally {
      snap.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
