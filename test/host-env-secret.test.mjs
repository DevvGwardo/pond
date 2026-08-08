// Unit tests for the host's capsule env helpers: the stable PER-DEPLOY
// session-secret default injected into every capsule .env.pond.server when the
// deployer didn't push one. Per-deploy (never host-wide) — the env file lives
// in the tenant-writable deploy dir, so a shared secret would let any tenant
// forge sessions for every other capsule on the host.

import { test } from "node:test"
import assert from "node:assert/strict"

import { envTextWithSessionSecret } from "../src/commands/host.js"

test("envTextWithSessionSecret keeps a deployer-supplied secret untouched", () => {
  const envText = "FOO=bar\nPOND_SESSION_SECRET=deployer-secret\nBAZ=qux\n"
  assert.equal(envTextWithSessionSecret(envText, undefined), envText)
})

test("envTextWithSessionSecret appends a fresh per-deploy secret when the key is missing", () => {
  const out = envTextWithSessionSecret("FOO=bar\n", undefined)
  assert.match(out, /^FOO=bar\nPOND_SESSION_SECRET=[0-9a-f]{64}\n$/)
})

test("envTextWithSessionSecret handles empty / undefined envText", () => {
  assert.match(envTextWithSessionSecret(undefined, undefined), /^POND_SESSION_SECRET=[0-9a-f]{64}\n$/)
  assert.match(envTextWithSessionSecret("", undefined), /^POND_SESSION_SECRET=[0-9a-f]{64}\n$/)
  // Comments-only envText still counts as "no secret"; comment is preserved.
  const commented = envTextWithSessionSecret("# nothing here\n", undefined)
  assert.match(commented, /^# nothing here\nPOND_SESSION_SECRET=[0-9a-f]{64}\n$/)
})

test("envTextWithSessionSecret replaces an overridden empty value", () => {
  const out = envTextWithSessionSecret("POND_SESSION_SECRET=\n", undefined)
  assert.match(out, /^POND_SESSION_SECRET=[0-9a-f]{64}\n$/)
})

test("envTextWithSessionSecret reuses the deploy's existing auto-generated secret", () => {
  // An update that doesn't push env must not rotate the secret — that would
  // log every existing session out on every redeploy.
  const onDisk = "a".repeat(64)
  const out = envTextWithSessionSecret(undefined, onDisk)
  assert.equal(out, `POND_SESSION_SECRET=${onDisk}\n`)
})

test("envTextWithSessionSecret mints a fresh secret per deploy (no cross-tenant reuse)", () => {
  const first = envTextWithSessionSecret(undefined, undefined)
  const second = envTextWithSessionSecret(undefined, undefined)
  assert.notEqual(first, second)
})
