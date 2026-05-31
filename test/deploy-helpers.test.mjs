// P3 item 13: unit tests for the pure CLI helpers in deploy.ts that previously
// had no coverage. These are string/time logic with no network or fs.

import { test } from "node:test"
import assert from "node:assert/strict"

import { slugifySubdomain, formatRelative } from "../src/commands/deploy.js"

test("slugifySubdomain produces a valid DNS label", () => {
  assert.equal(slugifySubdomain("My Cool App"), "my-cool-app")
  assert.equal(slugifySubdomain("UPPER_case"), "upper-case")
  assert.equal(slugifySubdomain("--leading-and-trailing--"), "leading-and-trailing")
  assert.equal(slugifySubdomain("weird!!!chars@@@here"), "weird-chars-here")
  // Collapses runs of separators and trims to <= 40 chars (with no trailing -).
  const long = slugifySubdomain("a".repeat(60))
  assert.ok(long.length <= 40)
  assert.ok(!long.endsWith("-"))
  // Pure punctuation slugifies to empty (caller treats this as "no alias").
  assert.equal(slugifySubdomain("***"), "")
})

test("formatRelative renders human durations and handles edge cases", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z")
  assert.equal(formatRelative(undefined, now), "")
  assert.equal(formatRelative("not-a-date", now), "")
  assert.equal(formatRelative("2026-01-01T00:00:30.000Z", now), "30 seconds")
  assert.equal(formatRelative("2026-01-01T00:01:00.000Z", now), "1 minute")
  assert.equal(formatRelative("2026-01-01T02:00:00.000Z", now), "2 hours")
  assert.equal(formatRelative("2026-01-03T00:00:00.000Z", now), "2 days")
  // Singular vs plural boundary.
  assert.equal(formatRelative("2026-01-01T00:00:01.000Z", now), "1 second")
})
