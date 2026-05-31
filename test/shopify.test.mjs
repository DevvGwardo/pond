// Unit test for ctx.shopify.graphql().
// Exercises the createShopify helper in an isolated child process so we can
// stub globalThis.fetch without affecting other tests.
//
// Coverage: missing env, URL normalization, correct headers/body, non-2xx
// response, and GraphQL errors array.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import * as path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const RUNTIME_URL = pathToFileURL(path.join(REPO_ROOT, "src", "runtime.js")).href

function runProbe(body) {
  const src = `
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
// avoid ts extension import issues by importing via the compiled alias path
import { createShopify } from ${JSON.stringify(RUNTIME_URL)}
${body}
`
  return execFileSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf-8",
    timeout: 15000,
  })
}

test("ctx.shopify.graphql throws when SHOPIFY_SHOP or SHOPIFY_TOKEN is missing", () => {
  const out = runProbe(`
const shopify = createShopify({})
try {
  await shopify.graphql("{ products { edges { node { id } } } }")
  console.log("FAIL:no error")
} catch (err) {
  if (/Set SHOPIFY_SHOP and SHOPIFY_TOKEN/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `missing-env check failed: ${out}`)
})

test("ctx.shopify.graphql throws when only SHOPIFY_SHOP is set", () => {
  const out = runProbe(`
const shopify = createShopify({ SHOPIFY_SHOP: "my-store.myshopify.com" })
try {
  await shopify.graphql("{ products { edges { node { id } } } }")
  console.log("FAIL:no error")
} catch (err) {
  if (/Set SHOPIFY_SHOP and SHOPIFY_TOKEN/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `missing-token check failed: ${out}`)
})

test("ctx.shopify.graphql throws when only SHOPIFY_TOKEN is set", () => {
  const out = runProbe(`
const shopify = createShopify({ SHOPIFY_TOKEN: "abc123" })
try {
  await shopify.graphql("{ products { edges { node { id } } } }")
  console.log("FAIL:no error")
} catch (err) {
  if (/Set SHOPIFY_SHOP and SHOPIFY_TOKEN/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `missing-shop check failed: ${out}`)
})

test("ctx.shopify.graphql builds correct URL, headers, body with stubbed fetch", () => {
  const out = runProbe(`
const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) })
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { products: { edges: [] } } }),
  }
}
const shopify = createShopify({
  SHOPIFY_SHOP: "my-store.myshopify.com",
  SHOPIFY_TOKEN: "shpat_abc123",
})
const result = await shopify.graphql("{ products { edges { node { id } } } }", { first: 10 })
if (calls.length !== 1) { console.log("FAIL:expected 1 call, got", calls.length); process.exit(1) }
const c = calls[0]
if (!c.url.includes("my-store.myshopify.com/admin/api/2025-01/graphql.json")) { console.log("FAIL:bad url:", c.url); process.exit(1) }
if (c.headers["X-Shopify-Access-Token"] !== "shpat_abc123") { console.log("FAIL:bad token header"); process.exit(1) }
if (c.headers["Content-Type"] !== "application/json") { console.log("FAIL:bad content-type"); process.exit(1) }
if (c.body.query !== "{ products { edges { node { id } } } }") { console.log("FAIL:bad query body"); process.exit(1) }
if (JSON.stringify(c.body.variables) !== '{"first":10}') { console.log("FAIL:bad variables body"); process.exit(1) }
if (!result || !result.products) { console.log("FAIL:result missing products"); process.exit(1) }
console.log("OK")
`)
  assert.match(out, /\bOK\b/, `request construction failed: ${out}`)
})

test("ctx.shopify.graphql normalizes bare shop name", () => {
  const out = runProbe(`
const calls = []
globalThis.fetch = async (url) => {
  calls.push(url)
  return { ok: true, status: 200, json: async () => ({ data: {} }) }
}
// bare store name without .myshopify.com suffix
const shopify = createShopify({ SHOPIFY_SHOP: "my-store", SHOPIFY_TOKEN: "abc" })
await shopify.graphql("{ x }")
if (calls.length !== 1) { console.log("FAIL:expected 1 call"); process.exit(1) }
if (!calls[0].includes("my-store.myshopify.com")) { console.log("FAIL:bare name not normalized:", calls[0]); process.exit(1) }
console.log("OK")
`)
  assert.match(out, /\bOK\b/, `bare-name normalization failed: ${out}`)
})

test("ctx.shopify.graphql normalizes URL with protocol and trailing slash", () => {
  const out = runProbe(`
const calls = []
globalThis.fetch = async (url) => {
  calls.push(url)
  return { ok: true, status: 200, json: async () => ({ data: {} }) }
}
const shopify = createShopify({ SHOPIFY_SHOP: "https://my-store.myshopify.com/", SHOPIFY_TOKEN: "abc" })
await shopify.graphql("{ x }")
if (!calls[0].includes("my-store.myshopify.com")) { console.log("FAIL:protocol/trailing slash not stripped:", calls[0]); process.exit(1) }
console.log("OK")
`)
  assert.match(out, /\bOK\b/, `protocol normalization failed: ${out}`)
})

test("ctx.shopify.graphql surfaces non-2xx status with Shopify error", () => {
  const out = runProbe(`
globalThis.fetch = async () => {
  return {
    ok: false,
    status: 401,
    json: async () => ({ errors: [{ message: "Invalid API key or access token" }] }),
  }
}
const shopify = createShopify({ SHOPIFY_SHOP: "my-store.myshopify.com", SHOPIFY_TOKEN: "bad" })
try {
  await shopify.graphql("{ products { edges { node { id } } } }")
  console.log("FAIL:no error")
} catch (err) {
  if (/Shopify API error: Invalid API key or access token/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `401 error propagation failed: ${out}`)
})

test("ctx.shopify.graphql surfaces GraphQL errors array", () => {
  const out = runProbe(`
globalThis.fetch = async () => {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: null, errors: [{ message: "Field 'blah' doesn't exist on type 'QueryRoot'" }] }),
  }
}
const shopify = createShopify({ SHOPIFY_SHOP: "my-store.myshopify.com", SHOPIFY_TOKEN: "abc" })
try {
  await shopify.graphql("{ blah }")
  console.log("FAIL:no error")
} catch (err) {
  if (/Shopify GraphQL error: Field 'blah'/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `GraphQL errors propagation failed: ${out}`)
})

test("ctx.shopify.graphql respects SHOPIFY_API_VERSION override", () => {
  const out = runProbe(`
const calls = []
globalThis.fetch = async (url) => {
  calls.push(url)
  return { ok: true, status: 200, json: async () => ({ data: {} }) }
}
const shopify = createShopify({
  SHOPIFY_SHOP: "my-store.myshopify.com",
  SHOPIFY_TOKEN: "abc",
  SHOPIFY_API_VERSION: "2024-10",
})
await shopify.graphql("{ x }")
if (!calls[0].includes("/admin/api/2024-10/graphql.json")) { console.log("FAIL:api version not respected:", calls[0]); process.exit(1) }
console.log("OK")
`)
  assert.match(out, /\bOK\b/, `API version override failed: ${out}`)
})
