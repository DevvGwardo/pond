import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  deployRecordPath,
  deriveControlPlaneFromDeployUrl,
  healDeployRecord,
  readDeployRecord,
} from "../src/host/deploy-record.js"
import { hasErrorCode } from "../src/commands/shared.js"

const cleanupDirs = []
after(() => {
  for (const d of cleanupDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
})

function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  cleanupDirs.push(d)
  return d
}

function seed(cwd, body) {
  mkdirSync(path.join(cwd, ".pond"), { recursive: true })
  writeFileSync(deployRecordPath(cwd), JSON.stringify(body, null, 2))
}

test("deriveControlPlaneFromDeployUrl strips the first DNS label", () => {
  assert.equal(deriveControlPlaneFromDeployUrl("https://46e8042f9ded40e8.pond.run"), "https://pond.run")
  assert.equal(deriveControlPlaneFromDeployUrl("https://abc.example.co.uk"), "https://example.co.uk")
})

test("deriveControlPlaneFromDeployUrl returns null when there is no parent zone", () => {
  assert.equal(deriveControlPlaneFromDeployUrl("https://pond.run"), null)
  assert.equal(deriveControlPlaneFromDeployUrl("not a url"), null)
})

test("healDeployRecord rewrites 0.0.0.0 apiUrl when url is a public host", () => {
  const record = {
    apiUrl: "http://0.0.0.0:8787",
    url: "https://46e8042f9ded40e8.pond.run",
  }
  const result = healDeployRecord(record)
  assert.equal(result.healed, true)
  assert.equal(result.before, "http://0.0.0.0:8787")
  assert.equal(result.after, "https://pond.run")
  assert.equal(record.apiUrl, "https://pond.run")
})

test("healDeployRecord rewrites IPv6 bind sentinel ::", () => {
  const record = {
    apiUrl: "http://[::]:8787",
    url: "https://abc1234567890def.pond.run",
  }
  const result = healDeployRecord(record)
  assert.equal(result.healed, true)
  assert.equal(record.apiUrl, "https://pond.run")
})

test("healDeployRecord leaves a legitimate self-hosted loopback record alone", () => {
  const record = {
    apiUrl: "http://0.0.0.0:8787",
    url: "http://localhost:8787",
  }
  const result = healDeployRecord(record)
  assert.equal(result.healed, false)
  assert.equal(record.apiUrl, "http://0.0.0.0:8787")
})

test("healDeployRecord leaves a healthy record alone", () => {
  const record = {
    apiUrl: "https://pond.run",
    url: "https://46e8042f9ded40e8.pond.run",
  }
  const result = healDeployRecord(record)
  assert.equal(result.healed, false)
})

test("healDeployRecord skips when apiUrl is missing", () => {
  const record = { url: "https://46e8042f9ded40e8.pond.run" }
  const result = healDeployRecord(record)
  assert.equal(result.healed, false)
})

test("healDeployRecord skips when no parent zone can be derived", () => {
  // url has only two labels — no parent zone; better to leave the record
  // alone than guess.
  const record = {
    apiUrl: "http://0.0.0.0:8787",
    url: "https://pond.run",
  }
  const result = healDeployRecord(record)
  assert.equal(result.healed, false)
  assert.equal(record.apiUrl, "http://0.0.0.0:8787")
})

test("readDeployRecord persists the repair to disk", () => {
  const cwd = tmp("pond-record-heal-")
  seed(cwd, {
    deployId: "46e8042f9ded40e8",
    apiUrl: "http://0.0.0.0:8787",
    url: "https://46e8042f9ded40e8.pond.run",
    claimToken: "abc",
  })

  const record = readDeployRecord(cwd)
  assert.ok(record)
  assert.equal(record.apiUrl, "https://pond.run")

  // re-read from disk to confirm the heal was written back, not just in memory
  const onDisk = JSON.parse(readFileSync(deployRecordPath(cwd), "utf-8"))
  assert.equal(onDisk.apiUrl, "https://pond.run")
  assert.equal(onDisk.deployId, "46e8042f9ded40e8", "other fields preserved")
  assert.equal(onDisk.claimToken, "abc", "other fields preserved")
})

test("readDeployRecord returns null for a missing file", () => {
  const cwd = tmp("pond-record-missing-")
  assert.equal(readDeployRecord(cwd), null)
})

test("readDeployRecord returns null for malformed JSON", () => {
  const cwd = tmp("pond-record-bad-")
  mkdirSync(path.join(cwd, ".pond"))
  writeFileSync(deployRecordPath(cwd), "{not json")
  assert.equal(readDeployRecord(cwd), null)
})

test("readDeployRecord is a no-op on a healthy record", () => {
  const cwd = tmp("pond-record-healthy-")
  const body = {
    deployId: "46e8042f9ded40e8",
    apiUrl: "https://pond.run",
    url: "https://46e8042f9ded40e8.pond.run",
  }
  seed(cwd, body)
  const beforeRaw = readFileSync(deployRecordPath(cwd), "utf-8")
  const record = readDeployRecord(cwd)
  assert.equal(record.apiUrl, "https://pond.run")
  // file contents shouldn't have been rewritten
  const afterRaw = readFileSync(deployRecordPath(cwd), "utf-8")
  assert.equal(beforeRaw, afterRaw, "healthy record should not be rewritten")
})

test("hasErrorCode finds ECONNREFUSED on a flat cause chain", () => {
  const err = new Error("fetch failed")
  err.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
  assert.equal(hasErrorCode(err, "ECONNREFUSED"), true)
})

test("hasErrorCode finds ECONNREFUSED inside an AggregateError (dual-stack localhost)", () => {
  const inner1 = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED" })
  const inner2 = Object.assign(new Error("connect ECONNREFUSED ::1:3000"), { code: "ECONNREFUSED" })
  const agg = new AggregateError([inner1, inner2], "")
  const err = Object.assign(new TypeError("fetch failed"), { cause: agg })
  assert.equal(hasErrorCode(err, "ECONNREFUSED"), true)
})

test("hasErrorCode returns false when no matching code is in the chain", () => {
  const err = new Error("fetch failed")
  err.cause = Object.assign(new Error("DNS failure"), { code: "ENOTFOUND" })
  assert.equal(hasErrorCode(err, "ECONNREFUSED"), false)
})

test("hasErrorCode terminates on a self-referential cause chain", () => {
  const err = new Error("loop")
  err.cause = err
  assert.equal(hasErrorCode(err, "ECONNREFUSED"), false)
})
