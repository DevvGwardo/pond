// Unit tests for the per-capsule bubblewrap filesystem confinement
// (src/host/capsule-fs-sandbox.ts). The bwrap integration itself is Linux-only
// and must be verified on a Linux host (see deploy/HARDENING.md), but the argv
// builder and mode resolution are pure and carry the security-critical
// invariants, so they are tested here on any platform.

import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveFsIsolationMode, buildBwrapArgv } from "../src/host/capsule-fs-sandbox.js"

const CONF = {
  nodeBin: "/usr/bin/node",
  nodeExecArgv: [
    "--max-old-space-size=256",
    "--permission",
    "--allow-fs-write=/data/.pond-host/deploys/abc",
    "--allow-addons",
  ],
  workerPath: "/opt/pond/src/host/deploy-worker.js",
  deployDir: "/data/.pond-host/deploys/abc",
  pondSrcDir: "/opt/pond/src",
  pondNodeModulesDir: "/opt/pond/node_modules",
}

// Find the value bound at a given mount flag for a given destination, e.g.
// pairFor(argv, "--bind", "/x") returns the source for `--bind <src> /x`.
function hasMount(argv, flag, src, dest) {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === flag && argv[i + 1] === src && argv[i + 2] === dest) return true
  }
  return false
}

test("resolveFsIsolationMode only accepts 'bwrap', everything else is off (fail safe default)", () => {
  assert.equal(resolveFsIsolationMode("bwrap"), "bwrap")
  assert.equal(resolveFsIsolationMode("BWRAP"), "bwrap")
  assert.equal(resolveFsIsolationMode("  bwrap  "), "bwrap")
  assert.equal(resolveFsIsolationMode("off"), "off")
  assert.equal(resolveFsIsolationMode(""), "off")
  assert.equal(resolveFsIsolationMode(undefined), "off")
  assert.equal(resolveFsIsolationMode(null), "off")
  assert.equal(resolveFsIsolationMode("landlock"), "off")
  assert.equal(resolveFsIsolationMode("true"), "off")
})

test("buildBwrapArgv binds the deploy dir read-WRITE and chdirs into it", () => {
  const argv = buildBwrapArgv(CONF)
  assert.ok(hasMount(argv, "--bind", CONF.deployDir, CONF.deployDir), "deploy dir must be --bind (rw)")
  // It must NOT be a read-only bind.
  assert.ok(!hasMount(argv, "--ro-bind", CONF.deployDir, CONF.deployDir), "deploy dir must not be ro")
  const ci = argv.indexOf("--chdir")
  assert.ok(ci !== -1 && argv[ci + 1] === CONF.deployDir, "must --chdir into the deploy dir")
})

test("buildBwrapArgv binds pond runtime + node_modules read-ONLY", () => {
  const argv = buildBwrapArgv(CONF)
  assert.ok(hasMount(argv, "--ro-bind", CONF.pondSrcDir, CONF.pondSrcDir), "pond src must be ro")
  assert.ok(hasMount(argv, "--ro-bind", CONF.pondNodeModulesDir, CONF.pondNodeModulesDir), "node_modules must be ro")
  // The runtime must never be writable.
  assert.ok(!hasMount(argv, "--bind", CONF.pondSrcDir, CONF.pondSrcDir), "pond src must not be rw")
  assert.ok(!hasMount(argv, "--bind", CONF.pondNodeModulesDir, CONF.pondNodeModulesDir), "node_modules must not be rw")
})

test("buildBwrapArgv NEVER exposes the control-plane data dir, control.db, host token, or siblings", () => {
  const argv = buildBwrapArgv(CONF)
  // The data dir is the parent of the deploy dir. It must not be bound in any
  // form — binding it would re-expose control.db, the host token, and every
  // sibling deploy, defeating the whole boundary.
  const dataDir = "/data/.pond-host"
  const deploysDir = "/data/.pond-host/deploys"
  const sibling = "/data/.pond-host/deploys/other"
  for (const flag of ["--bind", "--ro-bind", "--ro-bind-try", "--dev-bind"]) {
    for (const p of [dataDir, deploysDir, sibling, "/data/.pond-host/control.db", "/data/.pond-host/host-token"]) {
      assert.ok(!hasMount(argv, flag, p, p), `${flag} must not expose ${p}`)
    }
  }
  // Defensive: the only path under the data dir present anywhere in the argv is
  // this deploy's own dir (and the matching --allow-fs-write flag we pass through).
  const dataDirRefs = argv.filter((a) => a.startsWith(dataDir) && !a.startsWith(CONF.deployDir))
  assert.deepEqual(dataDirRefs, [], `no data-dir paths beyond the deploy dir, got ${JSON.stringify(dataDirRefs)}`)
})

test("buildBwrapArgv keeps the network namespace shared and isolates pid/ipc/uts", () => {
  const argv = buildBwrapArgv(CONF)
  // Net must stay shared: the control plane reaches the worker over loopback and
  // egress is governed by nftables/cgroup, not by this namespace.
  assert.ok(!argv.includes("--unshare-net"), "must NOT unshare net (would break loopback serving)")
  assert.ok(!argv.includes("--unshare-all"), "must NOT unshare-all (that includes net)")
  assert.ok(!argv.includes("--unshare-cgroup"), "must NOT unshare cgroup (nft egress matches on it)")
  assert.ok(argv.includes("--unshare-pid"), "should isolate pid namespace")
  assert.ok(argv.includes("--unshare-ipc"), "should isolate ipc namespace")
  assert.ok(argv.includes("--die-with-parent"), "should die with the control plane")
})

test("buildBwrapArgv execs node with the worker and preserves the --permission execArgv as defense-in-depth", () => {
  const argv = buildBwrapArgv(CONF)
  const sep = argv.indexOf("--")
  assert.ok(sep !== -1, "must have a -- separator before the command")
  const cmd = argv.slice(sep + 1)
  assert.equal(cmd[0], CONF.nodeBin)
  assert.equal(cmd[cmd.length - 1], CONF.workerPath)
  for (const flag of CONF.nodeExecArgv) {
    assert.ok(cmd.includes(flag), `inner node command must keep execArgv flag ${flag}`)
  }
  assert.equal(argv[0], "bwrap")
})
