// Unit tests for the Cloudflare Turnstile siteverify wrapper. The network call
// is stubbed so these run offline and deterministically. The host-side gating
// (configured vs not configured, anonymous-only) is covered in host.test.mjs.

import { test } from "node:test"
import assert from "node:assert/strict"

import { verifyTurnstile } from "../src/host/turnstile.js"

function stubFetch(impl) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    return impl(url, init)
  }
  fn.calls = calls
  return fn
}

test("verifyTurnstile: success when Cloudflare returns success:true", async () => {
  const fetchImpl = stubFetch(async () => ({ ok: true, json: async () => ({ success: true }) }))
  const r = await verifyTurnstile("secret", "good-token", "1.2.3.4", fetchImpl)
  assert.equal(r.ok, true)
  assert.equal(fetchImpl.calls.length, 1)
  const body = fetchImpl.calls[0].init.body
  assert.equal(body.get("secret"), "secret")
  assert.equal(body.get("response"), "good-token")
  assert.equal(body.get("remoteip"), "1.2.3.4")
})

test("verifyTurnstile: failure when Cloudflare returns success:false", async () => {
  const fetchImpl = stubFetch(async () => ({
    ok: true,
    json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
  }))
  const r = await verifyTurnstile("secret", "bad-token", undefined, fetchImpl)
  assert.equal(r.ok, false)
  assert.deepEqual(r.errorCodes, ["invalid-input-response"])
})

test("verifyTurnstile: missing token short-circuits without calling fetch", async () => {
  const fetchImpl = stubFetch(async () => ({ ok: true, json: async () => ({ success: true }) }))
  const r = await verifyTurnstile("secret", "", "1.2.3.4", fetchImpl)
  assert.equal(r.ok, false)
  assert.equal(fetchImpl.calls.length, 0)
})

test("verifyTurnstile: fails closed on network error", async () => {
  const fetchImpl = stubFetch(async () => {
    throw new Error("network down")
  })
  const r = await verifyTurnstile("secret", "tok", undefined, fetchImpl)
  assert.equal(r.ok, false)
})

test("verifyTurnstile: omits remoteip when ip is unknown", async () => {
  const fetchImpl = stubFetch(async () => ({ ok: true, json: async () => ({ success: true }) }))
  await verifyTurnstile("secret", "tok", "unknown", fetchImpl)
  assert.equal(fetchImpl.calls[0].init.body.has("remoteip"), false)
})
