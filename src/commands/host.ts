import { defineCommand } from "citty"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { bodyLimit } from "hono/body-limit"
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { fork, type ChildProcess } from "node:child_process"
import * as net from "node:net"
import { openControlDb, DEFAULT_QUOTA, ANONYMOUS_QUOTA, type ControlDb, type UserRow } from "../host/control-db.js"
import {
  cgroupLimitsFor,
  probeCapsuleCgroup,
  joinManagerCgroup,
  applyCapsuleCgroup,
  removeCapsuleCgroup,
} from "../host/cgroup.js"
import { findPackageJsonLifecycleScripts } from "../host/package-json-validation.js"
import { verifyTurnstile } from "../host/turnstile.js"
import { createHash } from "node:crypto"
import { buildForDeploy } from "../runtime.js"
import { buildClient } from "../bundler.js"
import { ideHtml } from "../ide/built.js"
import { dashboardHtml } from "../dashboard/built.js"
import { marked } from "marked"
import Database from "better-sqlite3"

// Curated docs catalog. Hand-written titles + summaries beat anything derivable
// from the markdown's H1 — the index page becomes navigation copy, not a file
// listing. Order = sidebar order. Slug = URL slug = filename minus `.md`.
const DOCS_CATALOG: ReadonlyArray<{ slug: string; title: string; summary: string }> = [
  {
    slug: "cli-reference",
    title: "CLI reference",
    summary: "Every pond subcommand: what it does, when to reach for it, the flags that matter.",
  },
  {
    slug: "api-reference",
    title: "Server API",
    summary: "The pond/server surface — capsule, query, mutation, table, types, ctx.db / ctx.ai / ctx.blob.",
  },
  {
    slug: "client-reference",
    title: "Client API",
    summary: "The pond/client surface — useQuery, useMutation, useAuth, plus the Preact runtime.",
  },
  {
    slug: "mcp",
    title: "MCP server",
    summary: "Drive pond from Claude Code / Cursor / any MCP client. Tools for deploys, source, logs, env.",
  },
  {
    slug: "operations",
    title: "Operations",
    summary: "Going from pond host on a laptop to a public service. The launch runbook.",
  },
] as const

const DOCS_SLUG_RE = /^[a-z0-9_-]+$/

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&amp;"
    if (c === "<") return "&lt;"
    if (c === ">") return "&gt;"
    if (c === '"') return "&quot;"
    return "&#39;"
  })
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80)
}

// Render markdown to HTML with stable heading IDs and a custom code-block
// wrapper. We deliberately skip syntax highlighting — the design language
// established in 0.3.0 ("don't fill everything with rainbow colors, prefer
// wireframe over fill") implies mono blocks with a thin border, no theming.
function renderMarkdown(md: string): string {
  const renderer = new marked.Renderer()
  const usedIds = new Map<string, number>()
  renderer.heading = ({ tokens, depth }) => {
    const text = tokens.map((t) => ("text" in t ? (t.text as string) : "")).join("")
    const base = slugifyHeading(text) || `section-${depth}`
    const seen = usedIds.get(base) ?? 0
    usedIds.set(base, seen + 1)
    const id = seen === 0 ? base : `${base}-${seen}`
    const inner = marked.parseInline(text) as string
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`
  }
  return marked.parse(md, {
    gfm: true,
    breaks: false,
    async: false,
    renderer,
  }) as string
}

const SOURCE_FILE_LIMIT = 200
const SOURCE_TOTAL_LIMIT = 4 * 1024 * 1024
const SOURCE_PATH_RE = /^(server|client|shared)\/[a-zA-Z0-9_./-]+$|^package\.json$/

function validateSourceFiles(
  input: unknown,
): { ok: true; files: Record<string, string> } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "sourceFiles must be an object" }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return { ok: false, error: "sourceFiles is empty" }
  if (entries.length > SOURCE_FILE_LIMIT) return { ok: false, error: `Too many files (max ${SOURCE_FILE_LIMIT})` }
  let total = 0
  const out: Record<string, string> = {}
  let hasServerEntry = false
  for (const [rel, content] of entries) {
    if (typeof content !== "string") return { ok: false, error: `File ${rel} is not a string` }
    if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) {
      return { ok: false, error: `Invalid path: ${rel}` }
    }
    if (!SOURCE_PATH_RE.test(rel)) {
      return { ok: false, error: `Path not allowed: ${rel}` }
    }
    total += Buffer.byteLength(content, "utf-8")
    if (total > SOURCE_TOTAL_LIMIT) return { ok: false, error: `Source exceeds ${SOURCE_TOTAL_LIMIT} bytes` }
    if (rel === "package.json") {
      // Refuse uploads that define npm lifecycle scripts. They'd run as RCE
      // on `npm install` for anyone who later forks the deploy.
      const lifecycle = findPackageJsonLifecycleScripts(content)
      if (!lifecycle.ok) {
        return {
          ok: false,
          error: `package.json defines npm lifecycle script(s) ${lifecycle.offending.join(", ")} which are not allowed on hosted deploys (pond builds via esbuild, not npm install)`,
        }
      }
    }
    out[rel] = content
    if (rel === "server/index.ts") hasServerEntry = true
  }
  if (!hasServerEntry) return { ok: false, error: "server/index.ts is required" }
  return { ok: true, files: out }
}

function writeSourceTree(deployDir: string, files: Record<string, string>): void {
  const sourceDir = path.join(deployDir, "source")
  fs.rmSync(sourceDir, { recursive: true, force: true })
  fs.mkdirSync(sourceDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(sourceDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
}

async function buildDeployFromSource(deployDir: string): Promise<{
  bundleBytes: number
  bundleHash: string
  meta: { isPublic: boolean; title?: string; description?: string }
}> {
  const sourceDir = path.join(deployDir, "source")
  const serverFile = path.join(sourceDir, "server", "index.ts")
  const clientFile = path.join(sourceDir, "client", "index.tsx")
  const outfile = path.join(deployDir, "deploy-bundle.mjs")
  await buildForDeploy(serverFile, sourceDir, outfile)
  if (fs.existsSync(clientFile)) {
    const html = await buildClient(clientFile)
    fs.writeFileSync(path.join(deployDir, "client.html"), html)
  } else {
    const stale = path.join(deployDir, "client.html")
    if (fs.existsSync(stale)) fs.rmSync(stale)
  }
  const bundleBuf = fs.readFileSync(outfile)
  const bundleHash = createHash("sha256").update(bundleBuf).digest("hex")
  const meta = extractCapsuleMeta(serverFile)
  return { bundleBytes: bundleBuf.length, bundleHash, meta }
}

// Replace JS/TS string literals and comments with a same-length blank so
// downstream regex scans don't false-positive on tokens that appear in
// strings or comments — e.g. a doc comment that mentions `public: true` or
// a regex literal that quotes another capsule's metadata. Lengths are
// preserved so source-position semantics (line/column) don't drift if a
// caller ever needs them.
//
// This is a deliberately small lexer — it handles single/double/backtick
// strings (incl. template-string interpolations as opaque strings, which
// is over-zealous but safe for the gallery-publication decision), `// line
// comments`, and `/* block */` comments. Regex literals are NOT handled —
// they're rare in capsule source and the cost of false-stripping a regex
// is just a missed isPublic detection (failed-closed for the public flag).
export function stripJsStringsAndComments(src: string): string {
  let out = ""
  const blank = (n: number) => " ".repeat(n)
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    // // line comment
    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i + 2)
      const end = nl === -1 ? n : nl
      out += blank(end - i)
      i = end
      continue
    }
    // /* block comment */
    if (c === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2)
      const end = close === -1 ? n : close + 2
      // preserve newlines so line numbers don't shift
      for (let k = i; k < end; k++) out += src[k] === "\n" ? "\n" : " "
      i = end
      continue
    }
    // string literal (single, double, backtick)
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      out += " "
      i++
      while (i < n) {
        const cc = src[i]
        if (cc === "\\" && i + 1 < n) {
          // preserve newlines for any newline introduced by an escape; the
          // simple `out += "  "` keeps length the same
          out += "  "
          i += 2
          continue
        }
        if (cc === quote) {
          out += " "
          i++
          break
        }
        out += cc === "\n" ? "\n" : " "
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

// Best-effort static parse of the capsule({ public, title, description }) call.
// We deliberately don't import the bundle to read these — that would execute
// arbitrary code on the host. Strings and comments are stripped first so a
// stray `public: true` in a comment or doc string can't unintentionally
// expose source via /gallery and /api/public-deploys/:id/source.
function extractCapsuleMeta(serverFile: string): { isPublic: boolean; title?: string; description?: string } {
  if (!fs.existsSync(serverFile)) return { isPublic: false }
  const rawSrc = fs.readFileSync(serverFile, "utf-8")
  const scanSrc = stripJsStringsAndComments(rawSrc)
  const isPublic = /\bpublic\s*:\s*true\b/.test(scanSrc)
  // Title and description are deliberately matched on the ORIGINAL source —
  // their values live inside string literals (which the stripper blanks out),
  // so we still need raw text. The risk of a stray comment/string mention of
  // `title: "Foo"` is just cosmetic gallery display, not a privacy issue.
  const titleMatch = rawSrc.match(/\btitle\s*:\s*(["'`])([^"'`]{1,200})\1/)
  const descMatch = rawSrc.match(/\bdescription\s*:\s*(["'`])([^"'`]{1,500})\1/)
  return {
    isPublic,
    title: titleMatch?.[2],
    description: descMatch?.[2],
  }
}

interface HostedDeployRecord {
  deployId: string
  // sha256 hex of the deploy's claim token. The plaintext is generated at
  // create time, returned to the client ONCE, then discarded — only the
  // hash is persisted. This is what `authorizeDeployMutation` and the
  // claim endpoint compare against. Pre-0.3.10 records have plaintext
  // `claimToken` instead; `readRecord` migrates them in place.
  claimTokenHash: string
  appPort: number
  url: string
  apiUrl: string
  publicInspect: boolean
  createdAt: string
  updatedAt: string
  claimedAt?: string
  bootError?: string
  // Capsule-declared metadata. Populated from a regex scan of server/index.ts
  // on each successful build — see extractCapsuleMeta(). Absent on records
  // that haven't been rebuilt since this field was introduced.
  isPublic?: boolean
  title?: string
  description?: string
  // Build metadata. Persisted on each successful build so the IDE's
  // diagnostics panel can render `✓ Built · 17.4 KB` on first mount instead
  // of "No build yet" (the previous in-tab-only state). Absent on records
  // that haven't been rebuilt since this field was introduced.
  bundleBytes?: number
  bundleHash?: string
  lastBuiltAt?: string
  lastBuildDurationMs?: number
}

// Pre-migration shape. Used only by `readRecord` to detect & upgrade
// records written before claim-token-hashing was introduced.
interface LegacyDeployRecord {
  deployId: string
  claimToken?: string
  claimTokenHash?: string
  [key: string]: unknown
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024
const MAX_ENV_BYTES = 64 * 1024
const MAX_ENV_ENTRIES = 256
const MAX_ENV_VALUE_CHARS = 1024

const RESERVED_SUBDOMAINS = new Set(["api", "admin", "docs", "www", "app", "health"])
const SUBDOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const HEX_DEPLOY_ID_RE = /^[a-f0-9]{16}$/
const MAX_DOMAINS_PER_USER = 50

function dirSize(dir: string): number {
  let total = 0
  if (!fs.existsSync(dir)) return 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.isFile()) {
        try {
          total += fs.statSync(p).size
        } catch {
          // ignore
        }
      }
    }
  }
  return total
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function bearer(header: string | undefined): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

function validateEnvText(text: string): { ok: true } | { ok: false; error: string } {
  if (Buffer.byteLength(text, "utf8") > MAX_ENV_BYTES) {
    return { ok: false, error: `envText exceeds ${MAX_ENV_BYTES} bytes` }
  }
  const parsed = parseEnvText(text)
  const keys = Object.keys(parsed)
  if (keys.length > MAX_ENV_ENTRIES) {
    return { ok: false, error: `envText exceeds ${MAX_ENV_ENTRIES} entries` }
  }
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      return { ok: false, error: `invalid env key: ${k}` }
    }
    if ((parsed[k] ?? "").length > MAX_ENV_VALUE_CHARS) {
      return { ok: false, error: `env value for ${k} exceeds ${MAX_ENV_VALUE_CHARS} chars` }
    }
  }
  return { ok: true }
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx === -1) continue
    out[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
  }
  return out
}

function serializeEnv(entries: Record<string, string>): string {
  return (
    Object.keys(entries)
      .sort()
      .map((k) => `${k}=${entries[k] ?? ""}`)
      .join("\n") + "\n"
  )
}

function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(s.trim())
  if (!m) throw new Error(`invalid duration: ${s}`)
  const n = parseInt(m[1], 10)
  switch (m[2]) {
    case "ms":
      return n
    case "s":
      return n * 1000
    case "m":
      return n * 60 * 1000
    case "h":
      return n * 60 * 60 * 1000
    case "d":
      return n * 24 * 60 * 60 * 1000
    default:
      throw new Error(`invalid duration unit: ${m[2]}`)
  }
}

function formatHumanDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s % 86400 === 0) return `${s / 86400} day${s / 86400 === 1 ? "" : "s"}`
  if (s % 3600 === 0) return `${s / 3600} hour${s / 3600 === 1 ? "" : "s"}`
  if (s % 60 === 0) return `${s / 60} minute${s / 60 === 1 ? "" : "s"}`
  return `${s} second${s === 1 ? "" : "s"}`
}

export const hostCommand = defineCommand({
  meta: {
    name: "host",
    description: "Start the Pond hosted control plane",
  },
  args: {
    port: {
      type: "string",
      default: "8787",
    },
    host: {
      type: "string",
      description: "Interface to bind (default 127.0.0.1)",
      default: "127.0.0.1",
    },
    "public-host": {
      type: "string",
      description: "Hostname used in returned deploy URLs (default localhost)",
      default: "localhost",
    },
    "public-base-url": {
      type: "string",
      description:
        "Full external base URL incl. scheme (e.g. https://pond.example.com). When set, deploy URLs use this " +
        "scheme/host/port instead of http://<public-host>:<port>. Use behind a TLS-terminating proxy.",
      default: "",
    },
    "abuse-email": {
      type: "string",
      description: "Contact email shown on the abuse / security pages (e.g. abuse@example.com)",
      default: "",
    },
    "data-dir": {
      type: "string",
      default: ".pond-host",
    },
    "anonymous-deploys": {
      type: "boolean",
      description: "Allow unauthenticated POST /api/deploys (Lakebed-style)",
      default: true,
    },
    "anonymous-grace": {
      type: "string",
      description: "How long before an unclaimed deploy's worker is terminated (e.g. 1h, 30m, 60s)",
      default: "1h",
    },
    "anonymous-retention": {
      type: "string",
      description: "How long before a terminated unclaimed deploy is deleted from disk",
      default: "7d",
    },
    "anonymous-rate-per-hour": {
      type: "string",
      description: "Max anonymous POST /api/deploys per IP per rolling hour",
      default: "5",
    },
    "turnstile-secret": {
      type: "string",
      description:
        "Cloudflare Turnstile secret. When set, anonymous POST /api/deploys must carry a verified Turnstile " +
        "token (x-pond-turnstile-token header or turnstileToken body field). Unset = no challenge. Also POND_TURNSTILE_SECRET.",
      default: "",
    },
    "trust-proxy": {
      type: "boolean",
      description: "Read client IP from x-forwarded-for (also POND_TRUST_PROXY_HEADERS=1)",
      default: false,
    },
    "capsule-cgroup-root": {
      type: "string",
      description:
        "Path to a delegated cgroup v2 subtree (e.g. /sys/fs/cgroup/pond.slice/capsules). When set and valid, " +
        "each capsule runs in its own child cgroup with cpu/memory/pids limits. Also POND_CAPSULE_CGROUP_ROOT.",
      default: "",
    },
    "capsule-egress": {
      type: "string",
      description:
        "Outbound network policy for ALL capsules (uniform, regardless of claim status): " +
        "'open' (legacy: only anonymous-unclaimed capsules are network-restricted; claimed capsules have full network), " +
        "'sealed' (no capsule may make outbound connections), or " +
        "'proxy' (capsules reach only their per-deploy allowlisted hosts via the egress proxy). " +
        "'proxy'/'sealed' REQUIRE the OS egress firewall (deploy/capsule-egress.nft) to be the real boundary. Also POND_CAPSULE_EGRESS.",
      default: "open",
    },
    "egress-proxy-port": {
      type: "string",
      description:
        "Loopback port for the allowlisting egress proxy when --capsule-egress=proxy. Also POND_EGRESS_PROXY_PORT.",
      default: "8788",
    },
  },
  async run({ args }) {
    const port = parseInt(typeof args.port === "string" ? args.port : "8787", 10)
    const hostname = typeof args.host === "string" && args.host ? args.host : "127.0.0.1"
    const publicHost =
      typeof args["public-host"] === "string" && args["public-host"] ? args["public-host"] : "localhost"
    const publicBaseUrlRaw =
      process.env.POND_PUBLIC_BASE_URL ?? (typeof args["public-base-url"] === "string" ? args["public-base-url"] : "")
    let publicBaseUrl: URL | null = null
    if (publicBaseUrlRaw) {
      try {
        publicBaseUrl = new URL(publicBaseUrlRaw.replace(/\/$/, ""))
      } catch {
        console.error(`[pond host] invalid --public-base-url: ${publicBaseUrlRaw}`)
        process.exit(1)
      }
    }
    const abuseEmail =
      process.env.POND_ABUSE_EMAIL ?? (typeof args["abuse-email"] === "string" ? args["abuse-email"] : "") ?? ""
    const dataDir = path.resolve(process.cwd(), typeof args["data-dir"] === "string" ? args["data-dir"] : ".pond-host")
    const deploysDir = path.join(dataDir, "deploys")
    const tokenFile = path.join(dataDir, "host-token")
    const apiUrl = `http://${hostname}:${port}`
    const runningChildren = new Map<string, { child: ChildProcess; port: number }>()
    // Crash-recovery state. A worker that exits unexpectedly is respawned with
    // backoff, but only RESTART_MAX times inside a rolling RESTART_WINDOW_MS so
    // a crash-looping capsule can't peg the CPU for its neighbours. The budget
    // resets on any user-initiated (re)deploy — see forkDeploy's `auto` flag.
    const restartState = new Map<string, { windowStart: number; count: number }>()
    const inFlightBoots = new Map<string, Promise<{ child: ChildProcess; port: number } | null>>()
    let shuttingDown = false
    const RESTART_MAX = 5
    const RESTART_WINDOW_MS = 60_000
    const RESTART_BACKOFF_MS = [500, 1000, 2000, 5000, 10000]
    const workerPath = path.resolve(import.meta.dirname, "../host/deploy-worker.js")
    const pondSrcDir = path.resolve(import.meta.dirname, "..")
    const pondNodeModulesDir = path.resolve(import.meta.dirname, "../../node_modules")
    const pondDocsDir = path.resolve(import.meta.dirname, "../../docs")

    const anonymousEnabled = args["anonymous-deploys"] !== false
    const graceStr =
      process.env.POND_ANONYMOUS_CLEANUP_GRACE ??
      (typeof args["anonymous-grace"] === "string" ? args["anonymous-grace"] : "1h")
    const retentionStr =
      process.env.POND_ANONYMOUS_CLEANUP_RETENTION ??
      (typeof args["anonymous-retention"] === "string" ? args["anonymous-retention"] : "7d")
    const anonymousGraceMs = parseDuration(graceStr)
    const anonymousRetentionMs = parseDuration(retentionStr)
    const anonymousRateLimit = parseInt(
      typeof args["anonymous-rate-per-hour"] === "string" ? args["anonymous-rate-per-hour"] : "5",
      10,
    )
    const turnstileSecret =
      process.env.POND_TURNSTILE_SECRET ??
      (typeof args["turnstile-secret"] === "string" ? args["turnstile-secret"] : "")
    const trustProxy = process.env.POND_TRUST_PROXY_HEADERS === "1" || args["trust-proxy"] === true

    // Uniform capsule egress policy (applies to ALL capsules regardless of
    // claim status). See the --capsule-egress flag.
    const egressModeRaw = (
      process.env.POND_CAPSULE_EGRESS ?? (typeof args["capsule-egress"] === "string" ? args["capsule-egress"] : "open")
    ).toLowerCase()
    if (!["open", "sealed", "proxy"].includes(egressModeRaw)) {
      console.error(`[pond host] invalid --capsule-egress: ${egressModeRaw} (expected open|sealed|proxy)`)
      process.exit(1)
    }
    if (egressModeRaw === "proxy") {
      // The egress proxy, its per-deploy allowlist API, and the worker-side
      // ProxyAgent (which needs the `undici` dependency) are staged but not yet
      // wired end-to-end; enabling this blindly would silently seal capsules.
      // The OS firewall + proxy module + control-db allowlist are in place —
      // see deploy/HARDENING.md for the remaining rollout steps.
      console.error(
        "[pond host] --capsule-egress=proxy is not yet wired end-to-end (worker ProxyAgent pending). " +
          "Use 'open' or 'sealed' for now; see deploy/HARDENING.md.",
      )
      process.exit(1)
    }
    const egressMode = egressModeRaw as "open" | "sealed"

    const nodeMajor = parseInt((process.versions.node ?? "0").split(".")[0], 10)
    const sandboxAvailable = nodeMajor >= 22 && fs.existsSync(pondSrcDir) && fs.existsSync(pondNodeModulesDir)
    if (!sandboxAvailable && anonymousEnabled) {
      console.log(
        `[pond host] Node ${process.versions.node} — permission model disabled. Upgrade to Node 22+ for anonymous deploy sandboxing.`,
      )
    }

    // Per-capsule cgroup v2 isolation. Validated once at startup; null disables
    // it (non-Linux, no delegation) and capsules fall back to the heap cap only.
    const capsuleCgroupRootRaw =
      process.env.POND_CAPSULE_CGROUP_ROOT ??
      (typeof args["capsule-cgroup-root"] === "string" ? args["capsule-cgroup-root"] : "")
    const capsuleCgroupRoot = probeCapsuleCgroup(capsuleCgroupRootRaw || null)
    if (capsuleCgroupRootRaw && !capsuleCgroupRoot) {
      console.log(
        `[pond host] capsule cgroup isolation requested (${capsuleCgroupRootRaw}) but the path is not a delegated cgroup v2 subtree with cpu/memory/pids — running without per-capsule CPU/memory caps.`,
      )
    }
    if (capsuleCgroupRoot && !joinManagerCgroup(capsuleCgroupRoot)) {
      console.log(
        `[pond host] note: could not move the manager into ${capsuleCgroupRoot}/manager — per-capsule limits may not bind unless this process is cgroup-delegated (see deploy/setup-capsule-isolation.sh).`,
      )
    }

    fs.mkdirSync(deploysDir, { recursive: true })
    const controlDb: ControlDb = openControlDb(dataDir)

    const ANON_DEPLOY_RATE_SCOPE = "anon_deploy_per_ip"
    const ANON_DEPLOY_RATE_WINDOW_MS = 60 * 60 * 1000
    function rateAllow(ip: string): boolean {
      return controlDb.rateAllow(ANON_DEPLOY_RATE_SCOPE, ip, ANON_DEPLOY_RATE_WINDOW_MS, anonymousRateLimit)
    }

    let hostToken = process.env.POND_HOST_TOKEN ?? ""
    let hostTokenGenerated = false
    if (!hostToken) {
      if (fs.existsSync(tokenFile)) {
        hostToken = fs.readFileSync(tokenFile, "utf-8").trim()
      } else {
        hostToken = randomBytes(32).toString("hex")
        fs.writeFileSync(tokenFile, hostToken, { mode: 0o600 })
        hostTokenGenerated = true
      }
    }

    function urlFor(deployId: string): string {
      if (publicBaseUrl) {
        const portPart = publicBaseUrl.port ? `:${publicBaseUrl.port}` : ""
        return `${publicBaseUrl.protocol}//${deployId}.${publicBaseUrl.hostname}${portPart}`
      }
      return `http://${deployId}.${publicHost}:${port}`
    }

    function urlForCustomDomain(subdomain: string): string {
      if (publicBaseUrl) {
        const portPart = publicBaseUrl.port ? `:${publicBaseUrl.port}` : ""
        return `${publicBaseUrl.protocol}//${subdomain}.${publicBaseUrl.hostname}${portPart}`
      }
      return `http://${subdomain}.${publicHost}:${port}`
    }

    // The external hostname (no scheme/port). Used to detect "bare-domain"
    // requests (the landing / abuse / security pages) vs subdomain requests
    // (proxy to a deploy).
    const externalHost = (publicBaseUrl?.hostname ?? publicHost).toLowerCase()

    function deployDirFor(deployId: string) {
      return path.join(deploysDir, deployId)
    }

    function metaFileFor(deployId: string) {
      return path.join(deployDirFor(deployId), "deploy.json")
    }

    function envFileFor(deployId: string) {
      return path.join(deployDirFor(deployId), ".env.pond.server")
    }

    function readRecord(deployId: string): HostedDeployRecord | null {
      if (!/^[a-f0-9]+$/i.test(deployId)) return null
      const file = metaFileFor(deployId)
      if (!fs.existsSync(file)) return null
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as LegacyDeployRecord
      // Migration: pre-0.3.10 records have plaintext `claimToken` and no
      // `claimTokenHash`. Compute the hash, drop the plaintext, rewrite once.
      // After migration the file no longer holds a usable claim token; a
      // backup leak only yields the hash.
      if (typeof raw.claimToken === "string" && typeof raw.claimTokenHash !== "string") {
        raw.claimTokenHash = sha256Hex(raw.claimToken)
        delete raw.claimToken
        try {
          fs.writeFileSync(file, JSON.stringify(raw, null, 2))
        } catch {
          // best-effort; the in-memory record still has the hash for this
          // request, and the next successful read will retry
        }
      }
      return raw as unknown as HostedDeployRecord
    }

    // In-memory cache for the unauthenticated public-deploys listing.
    // Declared BEFORE writeRecord because writeRecord calls
    // invalidatePublicListing() and the boot loop calls writeRecord during
    // module/run init — if `publicListingCache` is declared later in the
    // function body, that path hits a TDZ ReferenceError. The handler that
    // reads/writes the cache lives much further down with the rest of the
    // public-deploys route; it closes over these bindings.
    let publicListingCache: { body: { deploys: unknown[] }; expiresAt: number } | null = null
    const PUBLIC_LISTING_TTL_MS = 10_000
    function invalidatePublicListing() {
      publicListingCache = null
    }

    function writeRecord(record: HostedDeployRecord) {
      const dir = deployDirFor(record.deployId)
      fs.mkdirSync(dir, { recursive: true })
      // Defense in depth: even if a caller built a record with a stray
      // `claimToken` field, strip it before persisting. Only the hash
      // belongs on disk.
      const sanitized = { ...(record as unknown as Record<string, unknown>) }
      delete sanitized.claimToken
      fs.writeFileSync(metaFileFor(record.deployId), JSON.stringify(sanitized, null, 2))
      // Any record change can flip visibility (publish/unpublish/title/etc.)
      // — drop the public-listing cache so the next GET reflects reality.
      invalidatePublicListing()
    }

    function readEnv(deployId: string): Record<string, string> {
      const file = envFileFor(deployId)
      if (!fs.existsSync(file)) return {}
      return parseEnvText(fs.readFileSync(file, "utf-8"))
    }

    function writeEnv(deployId: string, entries: Record<string, string>) {
      const file = envFileFor(deployId)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, serializeEnv(entries), { mode: 0o600 })
    }

    function scopedEnvFor(_record: HostedDeployRecord): NodeJS.ProcessEnv {
      return {
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        HOME: process.env.HOME ?? "",
      }
    }

    async function stopDeploy(deployId: string) {
      const entry = runningChildren.get(deployId)
      if (!entry) return
      const { child } = entry
      runningChildren.delete(deployId)
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      try {
        child.send({ type: "shutdown" })
      } catch {
        child.kill("SIGKILL")
        return
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, 5000)
      timer.unref()
      await exited
      clearTimeout(timer)
    }

    async function forkDeploy(record: HostedDeployRecord, opts: { auto?: boolean } = {}): Promise<void> {
      // Isolation policy is derived in ONE place (bootOptsForRecord) so every
      // boot path — create, claim, update, redeploy, crash-respawn — applies
      // the same uniform sandbox/network rules. null means the deploy should
      // stay down (a terminated anonymous deploy past its grace window).
      const policy = bootOptsForRecord(record.deployId)
      if (!policy) return
      const useSandbox = policy.useSandbox
      const restrictNetwork = policy.restrictNetwork
      // A user-initiated (re)deploy ships potentially-fixed code, so it earns a
      // fresh crash budget. Automatic respawns (opts.auto) must NOT reset it,
      // or a fast boot→crash loop would never trip RESTART_MAX.
      if (!opts.auto) restartState.delete(record.deployId)
      const dir = deployDirFor(record.deployId)
      const bundlePath = path.join(dir, "deploy-bundle.mjs")
      const clientPath = path.join(dir, "client.html")
      if (!fs.existsSync(bundlePath)) return
      await stopDeploy(record.deployId)

      // Resolve symlinks: the permission model checks REAL paths (macOS /tmp →
      // /private/tmp), and the worker uses cwd to compute its data.db location,
      // so cwd / bundlePath must be in real form when the sandbox is active.
      const realDir = useSandbox && sandboxAvailable ? fs.realpathSync(dir) : dir
      const realBundlePath = useSandbox && sandboxAvailable ? fs.realpathSync(bundlePath) : bundlePath
      const realClientPath = fs.existsSync(clientPath)
        ? useSandbox && sandboxAvailable
          ? fs.realpathSync(clientPath)
          : clientPath
        : undefined

      const quota = controlDb.getQuota(record.deployId)
      const execArgv = [`--max-old-space-size=${quota.maxMemoryMb}`]
      if (useSandbox && sandboxAvailable) {
        // Node 24 removed `--experimental-permission`; the stable `--permission`
        // is available on Node 23+. Node 22 (LTS) shipped before the rename so
        // we keep the experimental form there.
        const permissionFlag = nodeMajor >= 23 ? "--permission" : "--experimental-permission"
        execArgv.push(
          permissionFlag,
          `--allow-fs-read=${realDir}`,
          `--allow-fs-read=${fs.realpathSync(pondSrcDir)}`,
          `--allow-fs-read=${fs.realpathSync(pondNodeModulesDir)}`,
          `--allow-fs-write=${realDir}`,
          "--allow-addons",
        )
      }
      const child = fork(workerPath, [], {
        cwd: realDir,
        env: scopedEnvFor(record),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv,
      })

      const deployId = record.deployId
      // Place the worker in its own cgroup before it does any real work, so the
      // bundle import and request handling are CPU/memory/pid bounded from the
      // start. No-op unless the host runs with a valid --capsule-cgroup-root.
      if (capsuleCgroupRoot && typeof child.pid === "number") {
        const placed = applyCapsuleCgroup(capsuleCgroupRoot, deployId, child.pid, cgroupLimitsFor(quota))
        if (!placed) {
          console.error(`[pond host] could not place deploy ${deployId} (pid ${child.pid}) in a cgroup`)
        }
      }
      child.on("exit", (code, signal) => {
        const cur = runningChildren.get(deployId)
        if (cur && cur.child === child) {
          runningChildren.delete(deployId)
          if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
            console.error(`[pond host] deploy ${deployId} worker exited unexpectedly (code=${code}, signal=${signal})`)
            scheduleRespawn(deployId)
          }
        }
      })

      try {
        const bootedPort = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.removeListener("message", onMessage)
            reject(new Error("Boot timed out after 10s"))
          }, 10000)
          const onMessage = (msg: any) => {
            if (msg?.type === "booted") {
              clearTimeout(timer)
              child.removeListener("message", onMessage)
              resolve(typeof msg.port === "number" ? msg.port : 0)
            } else if (msg?.type === "error") {
              clearTimeout(timer)
              child.removeListener("message", onMessage)
              reject(new Error(msg.message ?? "Worker reported error"))
            }
          }
          child.on("message", onMessage)
          child.once("exit", (code, signal) => {
            clearTimeout(timer)
            child.removeListener("message", onMessage)
            reject(new Error(`Worker exited before boot (code=${code}, signal=${signal})`))
          })
          child.send({
            type: "boot",
            options: {
              bundlePath: realBundlePath,
              clientPath: realClientPath,
              cwd: realDir,
              port: 0,
              hostname: "127.0.0.1",
              inspectSecretHash: record.claimTokenHash,
              publicInspect: record.publicInspect,
              restrictNetwork,
              maxRestoreBytes: quota.maxDiskBytes,
            },
          })
        })
        runningChildren.set(deployId, { child, port: bootedPort })
        record.appPort = bootedPort
        record.url = urlFor(deployId)
        if (record.bootError) {
          delete record.bootError
        }
        writeRecord(record)
      } catch (err: any) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        record.bootError = err?.message ?? String(err)
        writeRecord(record)
        throw err
      }
    }

    // Derive the sandbox/network options a deploy should boot with from its
    // current claim status. Returns null when the deploy should stay down
    // (anonymous deploy already terminated past its grace window).
    function bootOptsForRecord(deployId: string): { useSandbox: boolean; restrictNetwork: boolean } | null {
      const anon = controlDb.findAnonymous(deployId)
      if (anon && anon.terminated === 1) return null
      const isAnonUnclaimed = anon !== null
      // Isolation is UNIFORM: every capsule runs in the Node permission sandbox
      // regardless of claim status — claiming changes ownership/quota, not the
      // sandbox. Network policy follows --capsule-egress: 'sealed' restricts
      // every capsule's outbound; 'open' (legacy) restricts only anonymous,
      // unclaimed capsules and leaves claimed ones with full network.
      return {
        useSandbox: true,
        restrictNetwork: egressMode === "sealed" ? true : isAnonUnclaimed,
      }
    }

    // Respawn a worker that died unexpectedly, with backoff and a hard cap so a
    // capsule that crashes on boot can't spin forever and starve its neighbours.
    function scheduleRespawn(deployId: string) {
      if (shuttingDown) return
      const record = readRecord(deployId)
      if (!record) return
      const opts = bootOptsForRecord(deployId)
      if (!opts) return
      const now = Date.now()
      let st = restartState.get(deployId)
      if (!st || now - st.windowStart > RESTART_WINDOW_MS) {
        st = { windowStart: now, count: 0 }
        restartState.set(deployId, st)
      }
      if (st.count >= RESTART_MAX) {
        record.bootError = `Worker crashed ${RESTART_MAX}× within ${Math.round(RESTART_WINDOW_MS / 1000)}s — auto-restart paused until next deploy`
        writeRecord(record)
        console.error(`[pond host] deploy ${deployId} crash-looping — auto-restart paused`)
        return
      }
      const delay = RESTART_BACKOFF_MS[Math.min(st.count, RESTART_BACKOFF_MS.length - 1)]
      st.count++
      const timer = setTimeout(() => {
        void forkDeploy(record, { auto: true }).catch((err) => {
          console.error(`[pond host] respawn failed for ${deployId}: ${err?.message ?? err}`)
        })
      }, delay)
      timer.unref()
    }

    // Boot a deploy on demand when a request arrives for one that isn't running
    // (host restarted, or it was paused). Deduped via inFlightBoots so a burst
    // of concurrent requests triggers a single fork.
    async function ensureBooted(deployId: string): Promise<{ child: ChildProcess; port: number } | null> {
      const existing = runningChildren.get(deployId)
      if (existing) return existing
      const inFlight = inFlightBoots.get(deployId)
      if (inFlight) return inFlight
      const p = (async () => {
        const record = readRecord(deployId)
        if (!record) return null
        const opts = bootOptsForRecord(deployId)
        if (!opts) return null
        try {
          await forkDeploy(record, { auto: true })
        } catch {
          return null
        }
        return runningChildren.get(deployId) ?? null
      })()
      inFlightBoots.set(deployId, p)
      try {
        return await p
      } finally {
        inFlightBoots.delete(deployId)
      }
    }

    for (const entry of fs.readdirSync(deploysDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const record = readRecord(entry.name)
      if (!record) continue
      const anon = controlDb.findAnonymous(record.deployId)
      if (anon && anon.terminated === 1) continue
      try {
        // forkDeploy derives the uniform isolation policy itself.
        await forkDeploy(record)
      } catch (err) {
        console.error(`[pond host] boot failed for ${record.deployId}:`, err)
      }
    }

    function runSweep() {
      const now = new Date().toISOString()
      for (const id of controlDb.listForTermination(now)) {
        try {
          stopDeploy(id)
          controlDb.markTerminated(id)
          console.log(`[pond host] anonymous deploy ${id} terminated (grace passed)`)
        } catch (e) {
          console.error(`sweep terminate ${id}:`, e)
        }
      }
      for (const id of controlDb.listForDeletion(now)) {
        try {
          stopDeploy(id)
          restartState.delete(id)
          if (capsuleCgroupRoot) removeCapsuleCgroup(capsuleCgroupRoot, id)
          fs.rmSync(deployDirFor(id), { recursive: true, force: true })
          controlDb.deleteAnonymous(id)
          controlDb.deleteQuota(id)
          console.log(`[pond host] anonymous deploy ${id} deleted (retention passed)`)
        } catch (e) {
          console.error(`sweep delete ${id}:`, e)
        }
      }
      // Runtime disk watchdog. The per-deploy quota is enforced at deploy/build
      // time, but a running capsule can keep writing (blobs, data.db growth)
      // until it fills the shared /data volume and takes every neighbour down.
      // The cgroup caps cpu/memory/pids but NOT disk, so we poll here: a capsule
      // whose dir exceeds its disk quota is stopped (not respawned — see the
      // SIGTERM-clean exit handler) and flagged, freeing the volume.
      for (const id of [...runningChildren.keys()]) {
        try {
          const maxDiskBytes = controlDb.getQuota(id).maxDiskBytes
          if (!Number.isFinite(maxDiskBytes) || maxDiskBytes <= 0) continue
          const used = dirSize(deployDirFor(id))
          if (used > maxDiskBytes) {
            void stopDeploy(id)
            restartState.delete(id)
            const record = readRecord(id)
            if (record) {
              record.bootError = `Disk usage ${used} exceeds quota ${maxDiskBytes} — capsule stopped. Reduce on-disk data and redeploy.`
              writeRecord(record)
            }
            console.error(`[pond host] deploy ${id} over disk quota (${used} > ${maxDiskBytes}) — stopped`)
          }
        } catch (e) {
          console.error(`sweep disk-watchdog ${id}:`, e)
        }
      }
      try {
        controlDb.pruneRateLimits(ANON_DEPLOY_RATE_WINDOW_MS)
      } catch (e) {
        console.error("sweep prune rate_limits:", e)
      }
    }
    runSweep()
    const sweepTimer = setInterval(runSweep, 60_000)
    sweepTimer.unref()

    const app = new Hono()
    app.use("*", async (c, next) => {
      const origin = c.req.header("origin")
      const hostHdr = (c.req.header("host") ?? "").toLowerCase()
      let allow = false
      let originHost = ""
      if (origin) {
        try {
          originHost = new URL(origin).host.toLowerCase()
          if (originHost === hostHdr) allow = true
        } catch {
          // ignore
        }
      }
      const headers: Record<string, string> = {}
      if (allow && origin) {
        headers["access-control-allow-origin"] = origin
        headers["vary"] = "Origin"
        headers["access-control-allow-credentials"] = "true"
        headers["access-control-allow-headers"] = "content-type, authorization, x-pond-claim-token"
        headers["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS"
      }
      if (c.req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers })
      }
      await next()
      for (const [k, v] of Object.entries(headers)) {
        c.res.headers.set(k, v)
      }
    })

    app.get("/api/health", (c) => c.json({ ok: true }))

    function isHostToken(token: string): boolean {
      return safeEqual(token, hostToken)
    }

    function authUser(c: any): UserRow | null {
      const provided = bearer(c.req.header("authorization"))
      if (!provided) return null
      const user = controlDb.findUserByTokenHash(controlDb.hashToken(provided))
      return user
    }

    function requireUser(c: any): { user: UserRow } | Response {
      const user = authUser(c)
      if (!user) return c.json({ error: "Unauthorized" }, 401)
      return { user }
    }

    function requireAdmin(c: any): { user: UserRow | null; viaHostToken: boolean } | Response {
      const provided = bearer(c.req.header("authorization"))
      if (!provided) return c.json({ error: "Unauthorized" }, 401)
      if (isHostToken(provided)) return { user: null, viaHostToken: true }
      const user = controlDb.findUserByTokenHash(controlDb.hashToken(provided))
      if (!user || user.isAdmin !== 1) return c.json({ error: "Forbidden" }, 403)
      return { user, viaHostToken: false }
    }

    function clientIp(c: any): string {
      if (trustProxy) {
        // Prefer CF-Connecting-IP: Cloudflare OVERWRITES this header with the
        // real client IP on every request, so a client can't spoof it the way
        // they can prepend a bogus X-Forwarded-For entry. Only fall back to the
        // first XFF hop when the request didn't come through Cloudflare.
        const cf = c.req.header("cf-connecting-ip")
        if (cf && cf.trim()) return cf.trim()
        const xff = c.req.header("x-forwarded-for")
        if (xff) {
          const first = xff.split(",")[0]?.trim()
          if (first) return first
        }
      }
      try {
        const inc = c.env?.incoming
        const ip = inc?.socket?.remoteAddress
        if (typeof ip === "string" && ip) return ip
      } catch {
        // fall through
      }
      return "unknown"
    }

    function actorFor(user: UserRow | null, viaHostToken: boolean, anonymous = false): string {
      if (viaHostToken) return "__host__"
      if (anonymous) return "__anonymous__"
      return user?.id ?? "__unknown__"
    }

    function audit(
      actor: string,
      action: string,
      opts: { targetDeployId?: string; targetUserId?: string; metadata?: Record<string, unknown> } = {},
    ) {
      try {
        controlDb.appendAudit({
          actor,
          action,
          targetDeployId: opts.targetDeployId,
          targetUserId: opts.targetUserId,
          metadata: opts.metadata,
        })
      } catch (e) {
        console.error("[pond host] audit append failed:", e)
      }
    }

    function authorizeDeployMutation(
      c: any,
      record: HostedDeployRecord,
    ): { kind: "claim" } | { kind: "user"; user: UserRow } | Response {
      const claim = c.req.header("x-pond-claim-token") ?? ""
      if (claim && safeEqual(sha256Hex(claim), record.claimTokenHash)) {
        return { kind: "claim" }
      }
      const provided = bearer(c.req.header("authorization"))
      if (!provided) return c.json({ error: "Unauthorized" }, 401)
      if (isHostToken(provided)) {
        // host token gives admin powers
        return {
          kind: "user",
          user: { id: "__host__", username: "__host__", tokenHash: "", isAdmin: 1, createdAt: "" },
        }
      }
      const user = controlDb.findUserByTokenHash(controlDb.hashToken(provided))
      if (!user) return c.json({ error: "Unauthorized" }, 401)
      const ownerId = controlDb.getDeployOwner(record.deployId)
      if (user.isAdmin !== 1 && ownerId !== user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      return { kind: "user", user }
    }

    // ---- USERS ----

    app.post("/api/users", async (c) => {
      // First user bootstrap requires the host token; subsequent users require admin (host token or admin user).
      const provided = bearer(c.req.header("authorization"))
      if (!provided) return c.json({ error: "Unauthorized" }, 401)
      const hasAny = controlDb.hasAnyUser()
      if (!hasAny) {
        if (!isHostToken(provided)) return c.json({ error: "Unauthorized" }, 401)
      } else {
        if (!isHostToken(provided)) {
          const u = controlDb.findUserByTokenHash(controlDb.hashToken(provided))
          if (!u || u.isAdmin !== 1) return c.json({ error: "Forbidden" }, 403)
        }
      }
      const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; isAdmin?: unknown }
      if (typeof body.username !== "string" || !/^[a-z0-9_-]{1,32}$/i.test(body.username)) {
        return c.json({ error: "username must match /^[a-z0-9_-]{1,32}$/i" }, 400)
      }
      if (controlDb.findUserByUsername(body.username)) {
        return c.json({ error: "username taken" }, 409)
      }
      // First user is forced admin; otherwise honour isAdmin flag (default false).
      const isAdmin = !hasAny ? true : Boolean(body.isAdmin)
      const { user, token } = controlDb.createUser(body.username, isAdmin)
      const viaHostToken = isHostToken(provided)
      const actorUser = viaHostToken ? null : controlDb.findUserByTokenHash(controlDb.hashToken(provided))
      audit(actorFor(actorUser, viaHostToken), "user.create", {
        targetUserId: user.id,
        metadata: { username: user.username, isAdmin, bootstrap: !hasAny },
      })
      return c.json({ userId: user.id, username: user.username, isAdmin: user.isAdmin === 1, token }, 201)
    })

    app.get("/api/users/me", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      return c.json({ userId: r.user.id, username: r.user.username, isAdmin: r.user.isAdmin === 1 })
    })

    app.post("/api/users/me/rotate-token", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const token = controlDb.rotateUserToken(r.user.id)
      audit(actorFor(r.user, false), "user.rotate_token", { targetUserId: r.user.id })
      return c.json({ token })
    })

    // ---- AUDIT LOG ----

    app.get("/api/audit", (c) => {
      const r = requireAdmin(c)
      if (r instanceof Response) return r
      const limitRaw = c.req.query("limit")
      const sinceTs = c.req.query("sinceTs")
      const limit = limitRaw ? parseInt(limitRaw, 10) : 100
      const rows = controlDb.listAudit({
        limit: Number.isFinite(limit) ? limit : 100,
        sinceTs: typeof sinceTs === "string" && sinceTs.length > 0 ? sinceTs : undefined,
      })
      const entries = rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        actor: row.actor,
        action: row.action,
        targetDeployId: row.targetDeployId,
        targetUserId: row.targetUserId,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
      }))
      return c.json({ entries })
    })

    // ---- DEPLOYS ----

    app.get("/api/deploys", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const ids =
        r.user.isAdmin === 1
          ? fs
              .readdirSync(deploysDir, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
          : controlDb.listDeployIdsForUser(r.user.id)
      const records = ids
        .map((id) => readRecord(id))
        .filter((rec): rec is HostedDeployRecord => rec !== null)
        .map((rec) => {
          const anon = controlDb.findAnonymous(rec.deployId)
          // Custom subdomains added via `pond domains add` aren't on the
          // record — they live in control-db. Surface them so the dashboard
          // can prefer the friendly URL over the hash one.
          const domains = controlDb.listDomainsForDeploy(rec.deployId).map((d) => urlForCustomDomain(d.subdomain))
          return {
            deployId: rec.deployId,
            url: rec.url,
            apiUrl: rec.apiUrl,
            publicInspect: rec.publicInspect,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
            claimedAt: rec.claimedAt,
            ownerId: controlDb.getDeployOwner(rec.deployId),
            anonymous: anon !== null,
            terminatesAt: anon?.terminatesAt,
            expiresAt: anon?.expiresAt,
            terminated: anon?.terminated === 1,
            title: rec.title,
            description: rec.description,
            isPublic: rec.isPublic === true,
            domains,
          }
        })
      return c.json({ deploys: records })
    })

    app.post(
      "/api/deploys",
      bodyLimit({ maxSize: MAX_BUNDLE_BYTES, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
      async (c) => {
        const providedAuth = bearer(c.req.header("authorization"))
        let user: UserRow | null = null
        if (providedAuth) {
          user = controlDb.findUserByTokenHash(controlDb.hashToken(providedAuth))
          if (!user) return c.json({ error: "Unauthorized" }, 401)
        }
        const isAnonymous = user === null

        if (isAnonymous && !anonymousEnabled) {
          return c.json({ error: "Anonymous deploys disabled" }, 401)
        }
        if (isAnonymous) {
          const ip = clientIp(c)
          if (!rateAllow(ip)) {
            return new Response(JSON.stringify({ error: "Rate limit exceeded for anonymous deploys" }), {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "3600" },
            })
          }
        }
        const quotaTemplate = isAnonymous ? ANONYMOUS_QUOTA : DEFAULT_QUOTA

        const body = (await c.req.json().catch(() => null)) as {
          sourceFiles?: unknown
          publicInspect?: unknown
          turnstileToken?: unknown
        } | null
        if (!body) return c.json({ error: "Invalid JSON body" }, 400)
        // Human/bot challenge for anonymous deploys. No-op unless the operator
        // configured a Turnstile secret; authenticated deploys are never
        // challenged. Token may ride in a header or the JSON body.
        if (isAnonymous && turnstileSecret) {
          const headerToken = c.req.header("x-pond-turnstile-token") ?? ""
          const bodyToken = typeof body.turnstileToken === "string" ? body.turnstileToken : ""
          const token = headerToken || bodyToken
          const verdict = await verifyTurnstile(turnstileSecret, token, clientIp(c))
          if (!verdict.ok) {
            return c.json({ error: "Turnstile verification failed", errorCodes: verdict.errorCodes }, 403)
          }
        }
        const validated = validateSourceFiles(body.sourceFiles)
        if (!validated.ok) return c.json({ error: validated.error }, 400)
        const deployId = randomBytes(8).toString("hex")
        const claimToken = randomBytes(32).toString("hex")
        const dir = deployDirFor(deployId)
        fs.mkdirSync(dir, { recursive: true })
        writeSourceTree(dir, validated.files)
        const createStart = Date.now()
        let buildResult: {
          bundleBytes: number
          bundleHash: string
          meta: { isPublic: boolean; title?: string; description?: string }
        }
        try {
          buildResult = await buildDeployFromSource(dir)
        } catch (err: any) {
          fs.rmSync(dir, { recursive: true, force: true })
          return c.json({ error: `Build failed: ${err?.message ?? err}` }, 400)
        }
        if (buildResult.bundleBytes > quotaTemplate.maxBundleBytes) {
          fs.rmSync(dir, { recursive: true, force: true })
          return c.json(
            {
              error: `Bundle exceeds ${isAnonymous ? "anonymous" : "default"} per-deploy quota (${quotaTemplate.maxBundleBytes} bytes)`,
            },
            413,
          )
        }
        const sizeAfter = dirSize(dir)
        if (sizeAfter > quotaTemplate.maxDiskBytes) {
          fs.rmSync(dir, { recursive: true, force: true })
          return c.json({ error: `Disk usage ${sizeAfter} exceeds quota ${quotaTemplate.maxDiskBytes}` }, 413)
        }
        const nowIso = new Date().toISOString()
        const record: HostedDeployRecord = {
          deployId,
          // Persist only the hash. Plaintext `claimToken` returned to the
          // client below as a one-time disclosure.
          claimTokenHash: sha256Hex(claimToken),
          appPort: 0,
          url: urlFor(deployId),
          apiUrl,
          publicInspect: Boolean(body.publicInspect),
          createdAt: nowIso,
          updatedAt: nowIso,
          isPublic: buildResult.meta.isPublic,
          title: buildResult.meta.title,
          description: buildResult.meta.description,
          bundleBytes: buildResult.bundleBytes,
          bundleHash: buildResult.bundleHash,
          lastBuiltAt: nowIso,
          lastBuildDurationMs: Date.now() - createStart,
        }
        writeRecord(record)
        let extra: { terminatesAt?: string; expiresAt?: string } = {}
        if (isAnonymous) {
          controlDb.setQuota(deployId, ANONYMOUS_QUOTA)
          const { terminatesAt, expiresAt } = controlDb.createAnonymous(
            deployId,
            claimToken,
            anonymousGraceMs,
            anonymousRetentionMs,
          )
          extra = { terminatesAt, expiresAt }
        } else {
          controlDb.setDeployOwner(deployId, user!.id)
        }
        try {
          // forkDeploy derives the uniform isolation policy itself (the anon
          // row, if any, was just written above).
          await forkDeploy(record)
        } catch (err: any) {
          try {
            fs.rmSync(dir, { recursive: true, force: true })
          } catch {}
          if (isAnonymous) {
            controlDb.deleteAnonymous(deployId)
          } else {
            controlDb.deleteDeployOwner(deployId)
          }
          controlDb.deleteQuota(deployId)
          audit(actorFor(user, false, isAnonymous), "deploy.create_failed", {
            targetDeployId: deployId,
            metadata: {
              anonymous: isAnonymous,
              bundleBytes: buildResult.bundleBytes,
              error: String(err?.message ?? err),
            },
          })
          return c.json({ error: `Boot failed: ${err?.message ?? err}`, deployId }, 500)
        }
        audit(actorFor(user, false, isAnonymous), "deploy.create", {
          targetDeployId: deployId,
          targetUserId: user?.id,
          metadata: { anonymous: isAnonymous, bundleBytes: buildResult.bundleBytes },
        })
        return c.json(
          {
            ...record,
            // One-time disclosure of the plaintext claim token. Subsequent
            // reads of the record only see the hash.
            claimToken,
            ...extra,
            bundleHash: buildResult.bundleHash,
            bundleBytes: buildResult.bundleBytes,
          },
          201,
        )
      },
    )

    app.put(
      "/api/deploys/:deployId",
      bodyLimit({ maxSize: MAX_BUNDLE_BYTES, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
      async (c) => {
        const deployId = c.req.param("deployId")
        const record = readRecord(deployId)
        if (!record) return c.json({ error: "Not found" }, 404)
        if (controlDb.findAnonymous(deployId)) {
          return c.json({ error: "Anonymous deploys cannot be updated — claim first" }, 403)
        }
        const auth = authorizeDeployMutation(c, record)
        if (auth instanceof Response) return auth
        const body = (await c.req.json().catch(() => null)) as {
          sourceFiles?: unknown
          publicInspect?: unknown
          envText?: unknown
        } | null
        if (!body) return c.json({ error: "Invalid JSON body" }, 400)
        const validated = validateSourceFiles(body.sourceFiles)
        if (!validated.ok) return c.json({ error: validated.error }, 400)
        const quota = controlDb.getQuota(deployId)
        const dir = deployDirFor(deployId)
        writeSourceTree(dir, validated.files)
        const updateStart = Date.now()
        let buildResult: {
          bundleBytes: number
          bundleHash: string
          meta: { isPublic: boolean; title?: string; description?: string }
        }
        try {
          buildResult = await buildDeployFromSource(dir)
        } catch (err: any) {
          return c.json({ error: `Build failed: ${err?.message ?? err}` }, 400)
        }
        if (buildResult.bundleBytes > quota.maxBundleBytes) {
          return c.json({ error: `Bundle exceeds per-deploy quota (${quota.maxBundleBytes} bytes)` }, 413)
        }
        if (typeof body.envText === "string") {
          const v = validateEnvText(body.envText)
          if (!v.ok) return c.json({ error: v.error }, 413)
          fs.writeFileSync(path.join(dir, ".env.pond.server"), body.envText, { mode: 0o600 })
        }
        const sizeAfter = dirSize(dir)
        if (sizeAfter > quota.maxDiskBytes) {
          return c.json({ error: `Disk usage ${sizeAfter} exceeds quota ${quota.maxDiskBytes}` }, 413)
        }
        const updateNow = new Date().toISOString()
        record.publicInspect = Boolean(body.publicInspect)
        record.updatedAt = updateNow
        record.isPublic = buildResult.meta.isPublic
        record.title = buildResult.meta.title
        record.description = buildResult.meta.description
        record.bundleBytes = buildResult.bundleBytes
        record.bundleHash = buildResult.bundleHash
        record.lastBuiltAt = updateNow
        record.lastBuildDurationMs = Date.now() - updateStart
        writeRecord(record)
        try {
          await forkDeploy(record)
        } catch (err: any) {
          return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
        }
        const actor = auth.kind === "claim" ? "__claim_token__" : actorFor(auth.user, false)
        audit(actor, "deploy.update", {
          targetDeployId: deployId,
          metadata: { bundleBytes: buildResult.bundleBytes, envChanged: typeof body.envText === "string" },
        })
        return c.json({ ...record, bundleHash: buildResult.bundleHash, bundleBytes: buildResult.bundleBytes })
      },
    )

    app.post("/api/deploys/:deployId/claim", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const body = (await c.req.json().catch(() => ({}))) as {
        claimToken?: unknown
        signup?: unknown
        envText?: unknown
      }
      if (typeof body.claimToken !== "string") {
        return c.json({ error: "claimToken required" }, 400)
      }
      const anon = controlDb.findAnonymous(deployId)
      const tokenMatchesRecord = safeEqual(sha256Hex(body.claimToken), record.claimTokenHash)
      const tokenMatchesAnon = anon ? controlDb.verifyAnonymousClaim(deployId, body.claimToken) : false
      if (!tokenMatchesRecord && !tokenMatchesAnon) {
        return c.json({ error: "Forbidden" }, 403)
      }

      // Resolve user
      let user: UserRow | null = null
      let createdCredential: { username: string; token: string } | null = null

      const signup = body.signup as { username?: unknown } | undefined
      const bearerToken = bearer(c.req.header("authorization"))

      if (signup && typeof signup.username === "string") {
        if (!anon) {
          return c.json({ error: "signup only allowed for unclaimed anonymous deploys" }, 400)
        }
        const baseName = signup.username
        if (!/^[a-z0-9_-]{1,29}$/i.test(baseName)) {
          return c.json({ error: "username must match /^[a-z0-9_-]{1,29}$/i" }, 400)
        }
        // Try base, then base-2 ... base-99.
        let chosen: string | null = null
        if (!controlDb.findUserByUsername(baseName)) {
          chosen = baseName
        } else {
          for (let n = 2; n <= 99; n++) {
            const candidate = `${baseName}-${n}`
            if (!controlDb.findUserByUsername(candidate)) {
              chosen = candidate
              break
            }
          }
        }
        if (!chosen) {
          return c.json({ error: "username taken (tried -2..-99)" }, 409)
        }
        // Never grant admin via self-service claim/signup. Admin bootstrap goes
        // through POST /api/users, which requires the host token for the first
        // user — minting an admin here would let the first anonymous claimer on
        // a fresh host take over.
        const created = controlDb.createUser(chosen, false)
        user = created.user
        createdCredential = { username: created.user.username, token: created.token }
      } else if (bearerToken) {
        user = controlDb.findUserByTokenHash(controlDb.hashToken(bearerToken))
        if (!user) return c.json({ error: "Unauthorized" }, 401)
      } else {
        return c.json({ error: "Provide signup or Authorization" }, 400)
      }

      if (anon) {
        controlDb.promoteAnonymous(deployId, user.id)
        // First claim of an anonymous deploy — also reset the quota row so the
        // claimed deploy gets the larger DEFAULT_QUOTA instead of inheriting
        // ANONYMOUS_QUOTA forever. (Bug pre-0.3.9: claimed-from-anon deploys
        // were stuck at 16MB bundle / 128MB disk / 128MB memory.)
        controlDb.setQuota(deployId, DEFAULT_QUOTA)
      } else {
        // Re-claim of an ALREADY-OWNED deploy. The claim token alone is NOT
        // sufficient to transfer ownership — anyone with a copy of `.pond/
        // deploy.json`, an IDE link with `#token=…`, or the persisted
        // `localStorage` value could otherwise dispossess the current owner
        // silently. Allow only the existing owner / an admin / the host
        // token to perform this no-op reattachment.
        const currentOwnerId = controlDb.getDeployOwner(deployId)
        const isCurrentOwner = currentOwnerId !== null && currentOwnerId === user.id
        if (!isCurrentOwner && user.isAdmin !== 1) {
          audit(actorFor(user, false), "deploy.claim_denied", {
            targetDeployId: deployId,
            targetUserId: user.id,
            metadata: { reason: "not_current_owner_or_admin" },
          })
          return c.json({ error: "Deploy already owned by another account" }, 403)
        }
        controlDb.setDeployOwner(deployId, user.id)
      }

      if (typeof body.envText === "string") {
        const v = validateEnvText(body.envText)
        if (!v.ok) return c.json({ error: v.error }, 413)
        fs.writeFileSync(path.join(deployDirFor(deployId), ".env.pond.server"), body.envText, { mode: 0o600 })
      }
      // Rotate the claim token on every successful claim. The token that
      // authorized this claim may have leaked (IDE links with #token=…,
      // .pond/deploy.json, persisted localStorage). authorizeDeployMutation
      // still accepts the claim token for mutate/delete, so a stale copy would
      // otherwise stay a live write/delete credential after ownership. Minting
      // a fresh token here invalidates every leaked copy of the old one; the
      // legitimate caller persists the new value we return below.
      const rotatedClaimToken = randomBytes(32).toString("hex")
      record.claimTokenHash = sha256Hex(rotatedClaimToken)
      record.claimedAt = record.claimedAt ?? new Date().toISOString()
      record.updatedAt = new Date().toISOString()
      writeRecord(record)
      try {
        await forkDeploy(record)
      } catch (err: any) {
        return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
      }
      audit(actorFor(user, false), "deploy.claim", {
        targetDeployId: deployId,
        targetUserId: user.id,
        metadata: {
          fromAnonymous: anon !== null,
          signedUp: createdCredential !== null,
        },
      })
      const resp: Record<string, unknown> = {
        ...record,
        // Return the freshly rotated plaintext claim token so the client can
        // persist it. The server stores only the hash; the old token the
        // client sent in body.claimToken is now dead.
        claimToken: rotatedClaimToken,
      }
      if (createdCredential) resp.user = createdCredential
      return c.json(resp)
    })

    app.post("/api/deploys/:deployId/rotate-claim-token", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const r = requireUser(c)
      if (r instanceof Response) return r
      const ownerId = controlDb.getDeployOwner(deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      const newToken = randomBytes(32).toString("hex")
      record.claimTokenHash = sha256Hex(newToken)
      record.updatedAt = new Date().toISOString()
      writeRecord(record)
      try {
        await forkDeploy(record)
      } catch (err: any) {
        return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
      }
      audit(actorFor(r.user, false), "deploy.rotate_claim_token", { targetDeployId: deployId })
      return c.json({ deployId, claimToken: newToken })
    })

    app.delete("/api/deploys/:deployId", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const auth = authorizeDeployMutation(c, record)
      if (auth instanceof Response) return auth
      await stopDeploy(deployId)
      restartState.delete(deployId)
      if (capsuleCgroupRoot) removeCapsuleCgroup(capsuleCgroupRoot, deployId)
      fs.rmSync(deployDirFor(deployId), { recursive: true, force: true })
      controlDb.deleteDeployOwner(deployId)
      controlDb.deleteAnonymous(deployId)
      controlDb.deleteQuota(deployId)
      controlDb.removeDomainsForDeploy(deployId)
      invalidatePublicListing()
      const actor = auth.kind === "claim" ? "__claim_token__" : actorFor(auth.user, false)
      audit(actor, "deploy.delete", { targetDeployId: deployId })
      return c.json({ ok: true })
    })

    // Operator kill switch. Mirrors the sweep's terminate path (stopDeploy +
    // markTerminated) but on demand, gated by the host token / an admin user —
    // backs `pond admin terminate <deployId>`. Anonymous deploys are marked
    // terminated so they stay down (bootOptsForRecord returns null) and the
    // retention sweep still deletes them; non-anonymous deploys are stopped
    // (the operator can DELETE them outright if they want the bytes gone too).
    app.post("/api/admin/deploys/:deployId/terminate", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const r = requireAdmin(c)
      if (r instanceof Response) return r
      await stopDeploy(deployId)
      restartState.delete(deployId)
      const anonymous = controlDb.findAnonymous(deployId) !== null
      if (anonymous) controlDb.markTerminated(deployId)
      invalidatePublicListing()
      audit(actorFor(r.user, r.viaHostToken), "deploy.terminate", {
        targetDeployId: deployId,
        metadata: { anonymous },
      })
      return c.json({ ok: true, deployId, anonymous, terminated: true })
    })

    app.put("/api/deploys/:deployId/quota", async (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const r = requireAdmin(c)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => null)) as {
        maxBundleBytes?: unknown
        maxDiskBytes?: unknown
        maxMemoryMb?: unknown
        maxCpuPercent?: unknown
      } | null
      if (!body) return c.json({ error: "Invalid JSON body" }, 400)
      if (
        body.maxBundleBytes === undefined &&
        body.maxDiskBytes === undefined &&
        body.maxMemoryMb === undefined &&
        body.maxCpuPercent === undefined
      ) {
        return c.json({ error: "At least one of maxBundleBytes/maxDiskBytes/maxMemoryMb/maxCpuPercent required" }, 400)
      }
      const patch: { maxBundleBytes?: number; maxDiskBytes?: number; maxMemoryMb?: number; maxCpuPercent?: number } = {}
      if (body.maxBundleBytes !== undefined) {
        if (typeof body.maxBundleBytes !== "number" || body.maxBundleBytes <= 0) {
          return c.json({ error: "maxBundleBytes must be positive number" }, 400)
        }
        patch.maxBundleBytes = body.maxBundleBytes
      }
      if (body.maxDiskBytes !== undefined) {
        if (typeof body.maxDiskBytes !== "number" || body.maxDiskBytes <= 0) {
          return c.json({ error: "maxDiskBytes must be positive number" }, 400)
        }
        patch.maxDiskBytes = body.maxDiskBytes
      }
      if (body.maxMemoryMb !== undefined) {
        if (typeof body.maxMemoryMb !== "number" || body.maxMemoryMb <= 0) {
          return c.json({ error: "maxMemoryMb must be positive number" }, 400)
        }
        patch.maxMemoryMb = body.maxMemoryMb
      }
      if (body.maxCpuPercent !== undefined) {
        if (typeof body.maxCpuPercent !== "number" || body.maxCpuPercent <= 0) {
          return c.json({ error: "maxCpuPercent must be positive number" }, 400)
        }
        patch.maxCpuPercent = body.maxCpuPercent
      }
      const prev = controlDb.getQuota(deployId)
      const next = controlDb.setQuota(deployId, patch)
      if (next.maxMemoryMb !== prev.maxMemoryMb || next.maxCpuPercent !== prev.maxCpuPercent) {
        try {
          await forkDeploy(record)
        } catch (err: any) {
          return c.json({ error: `Re-fork failed: ${err?.message ?? err}`, quota: next }, 500)
        }
      }
      audit(actorFor(r.user, r.viaHostToken), "deploy.quota_update", {
        targetDeployId: deployId,
        metadata: { patch, prev, next },
      })
      return c.json({ quota: next })
    })

    app.get("/api/deploys/:deployId/quota", (c) => {
      const deployId = c.req.param("deployId")
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const r = requireUser(c)
      if (r instanceof Response) return r
      const ownerId = controlDb.getDeployOwner(deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      return c.json({ quota: controlDb.getQuota(deployId) })
    })

    // ---- ENV CRUD ----

    function requireDeployOwner(c: any, deployId: string): { record: HostedDeployRecord } | Response {
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      if (controlDb.findAnonymous(deployId)) {
        return c.json({ error: "Anonymous deploys cannot manage env — claim first" }, 403)
      }
      const r = requireUser(c)
      if (r instanceof Response) return r
      const ownerId = controlDb.getDeployOwner(deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      return { record }
    }

    app.get("/api/deploys/:deployId/env", (c) => {
      const deployId = c.req.param("deployId")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      const entries = readEnv(deployId)
      return c.json({ entries })
    })

    // Bearer-authed proxy for the deploy's recent log buffer. Deploy workers
    // write to `<deployDir>/.pond/logs.ndjson` (cwd is the deploy dir — see
    // `forkDeploy`). The worker also exposes `GET /__pond/logs` as an SSE
    // stream, but that endpoint is gated on `x-pond-claim-token`, which only
    // the deploying machine ever sees in plaintext. MCP tools authenticate
    // with the account bearer, so they cannot reach the worker directly —
    // hence this control-plane proxy that owner-checks via bearer and reads
    // the same on-disk replay buffer.
    app.get("/api/deploys/:deployId/logs", (c) => {
      const deployId = c.req.param("deployId")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      const raw = c.req.query("limit")
      const parsed = raw === undefined ? 100 : Number.parseInt(raw, 10)
      const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100
      const logFile = path.join(deployDirFor(deployId), ".pond", "logs.ndjson")
      if (!fs.existsSync(logFile)) return c.json({ entries: [] })
      const text = fs.readFileSync(logFile, "utf-8")
      const lines = text.split("\n").filter((l) => l.length > 0)
      const start = Math.max(0, lines.length - limit)
      const entries: unknown[] = []
      for (let i = start; i < lines.length; i++) {
        try {
          entries.push(JSON.parse(lines[i]))
        } catch {
          // skip malformed lines (rotation race, partial write)
        }
      }
      return c.json({ entries })
    })

    // Inspect a hosted capsule's DB schema + source layout. Opens the
    // capsule's SQLite file read-only so it's safe while the worker is
    // running (WAL mode allows concurrent readers). Used by the dashboard
    // detail page to render an Outline / KPI overview without a CORS hop
    // through the capsule itself.
    app.get("/api/deploys/:deployId/inspect", (c) => {
      const deployId = c.req.param("deployId")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      const dir = deployDirFor(deployId)
      const dbPath = path.join(dir, ".pond", "data.db")
      const sourceDir = path.join(dir, "source")

      type TableInfo = { name: string; rowCount: number; columns: number }
      let tables: TableInfo[] = []
      let dbBytes = 0
      let dbOpenError: string | undefined
      if (fs.existsSync(dbPath)) {
        try {
          dbBytes = fs.statSync(dbPath).size
        } catch {
          // best-effort
        }
        let db: Database.Database | undefined
        try {
          db = new Database(dbPath, { readonly: true, fileMustExist: true })
          const rows = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_pond_%' ORDER BY name ASC",
            )
            .all() as Array<{ name: string }>
          for (const { name } of rows) {
            // Identifier validation: sqlite_master `name` is the table's
            // declared identifier. Reject anything outside the safe alnum/_
            // set before interpolating into the COUNT(*) statement.
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
            let rowCount = 0
            let columns = 0
            try {
              const c = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }
              rowCount = Number(c?.n ?? 0)
            } catch {
              // table might be locked or schema is unusual — surface zero
            }
            try {
              const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as unknown[]
              columns = cols.length
            } catch {
              // best-effort
            }
            tables.push({ name, rowCount, columns })
          }
        } catch (err) {
          dbOpenError = err instanceof Error ? err.message : String(err)
        } finally {
          try {
            db?.close()
          } catch {
            // ignore close errors on a read-only handle
          }
        }
      }

      let sourceFileCount = 0
      const countFiles = (rel: string) => {
        const abs = path.join(sourceDir, rel)
        if (!fs.existsSync(abs)) return
        const stat = fs.statSync(abs)
        if (stat.isFile()) {
          sourceFileCount += 1
          return
        }
        if (stat.isDirectory()) {
          for (const entry of fs.readdirSync(abs)) {
            if (entry === "node_modules" || entry.startsWith(".")) continue
            countFiles(path.join(rel, entry))
          }
        }
      }
      try {
        countFiles("")
      } catch {
        // best-effort; partial counts still useful
      }

      const totalRows = tables.reduce((acc, t) => acc + t.rowCount, 0)
      return c.json({
        deployId,
        dbBytes,
        dbOpenError,
        tableCount: tables.length,
        totalRows,
        tables,
        sourceFileCount,
      })
    })

    // Toggle a capsule's public-inspect flag without redeploying its source.
    // Owner-only. Triggers forkDeploy because the worker reads the flag from
    // its spawn args — changing it without restart would leave the running
    // worker with stale state.
    app.patch("/api/deploys/:deployId/visibility", async (c) => {
      const deployId = c.req.param("deployId")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => null)) as { publicInspect?: unknown } | null
      if (!body || typeof body.publicInspect !== "boolean") {
        return c.json({ error: "body must be { publicInspect: boolean }" }, 400)
      }
      r.record.publicInspect = body.publicInspect
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      try {
        await forkDeploy(r.record)
      } catch (err: any) {
        return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
      }
      const actor = authUser(c)
      if (actor) {
        audit(actorFor(actor, false), "deploy.visibility_update", {
          targetDeployId: deployId,
          metadata: { publicInspect: r.record.publicInspect },
        })
      }
      return c.json({ deployId, publicInspect: r.record.publicInspect })
    })

    // Sample recent rows from a named table in the capsule's DB. Used by the
    // dashboard Overview "Recent activity" panel and by the Tables tab for a
    // drill-down preview. Read-only WAL-safe open; identifier whitelisted
    // before interpolation. Ordering: prefer the table's `id` column DESC if
    // present, else fall back to the intrinsic `rowid` DESC (which is also
    // present on WITHOUT ROWID tables for our practical schemas — but if the
    // PRAGMA reports no `rowid` available we surface a friendly error rather
    // than throwing).
    app.get("/api/deploys/:deployId/inspect/table/:name", (c) => {
      const deployId = c.req.param("deployId")
      const name = c.req.param("name")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return c.json({ error: "invalid table name" }, 400)
      }
      const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10)
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20
      const dir = deployDirFor(deployId)
      const dbPath = path.join(dir, ".pond", "data.db")
      if (!fs.existsSync(dbPath)) return c.json({ error: "capsule has no database yet" }, 404)

      let db: Database.Database | undefined
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true })
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
          | { name: string }
          | undefined
        if (!exists) return c.json({ error: `unknown table: ${name}` }, 404)

        const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string }>
        const hasIdColumn = cols.some((col) => col.name === "id")
        // sqlite_master.sql is the table's CREATE statement. WITHOUT ROWID
        // tables can't be ordered by rowid; detect by substring match (the
        // statement always normalises to lowercase "without rowid" via
        // sqlite's parser when stored back) and skip ordering rather than
        // erroring out on a malformed query.
        const createSql =
          (
            db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
              | { sql: string }
              | undefined
          )?.sql ?? ""
        const isWithoutRowid = /without\s+rowid/i.test(createSql)

        let rows: unknown[] = []
        if (hasIdColumn) {
          rows = db.prepare(`SELECT * FROM "${name}" ORDER BY id DESC LIMIT ?`).all(limit)
        } else if (!isWithoutRowid) {
          rows = db.prepare(`SELECT *, rowid AS __rowid FROM "${name}" ORDER BY rowid DESC LIMIT ?`).all(limit)
        } else {
          // No id and no rowid — return rows in whatever order sqlite gives.
          rows = db.prepare(`SELECT * FROM "${name}" LIMIT ?`).all(limit)
        }

        const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n
        return c.json({
          name,
          columns: cols.map((col) => ({ name: col.name, type: col.type })),
          rows,
          rowCount: Number(total ?? 0),
          orderBy: hasIdColumn ? "id DESC" : !isWithoutRowid ? "rowid DESC" : "natural",
        })
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
      } finally {
        try {
          db?.close()
        } catch {
          // ignore close errors on read-only handle
        }
      }
    })

    app.put("/api/deploys/:deployId/env", async (c) => {
      const deployId = c.req.param("deployId")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => ({}))) as { entries?: unknown }
      if (!body.entries || typeof body.entries !== "object" || Array.isArray(body.entries)) {
        return c.json({ error: "entries object required" }, 400)
      }
      const incoming = body.entries as Record<string, unknown>
      const merged = readEnv(deployId)
      for (const [k, v] of Object.entries(incoming)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          return c.json({ error: `invalid key: ${k}` }, 400)
        }
        if (typeof v !== "string") {
          return c.json({ error: `value for ${k} must be string` }, 400)
        }
        if (v.length > MAX_ENV_VALUE_CHARS) {
          return c.json({ error: `value for ${k} exceeds ${MAX_ENV_VALUE_CHARS} chars` }, 413)
        }
        merged[k] = v
      }
      if (Object.keys(merged).length > MAX_ENV_ENTRIES) {
        return c.json({ error: `merged env exceeds ${MAX_ENV_ENTRIES} entries` }, 413)
      }
      const serializedBytes = Buffer.byteLength(serializeEnv(merged), "utf8")
      if (serializedBytes > MAX_ENV_BYTES) {
        return c.json({ error: `merged env exceeds ${MAX_ENV_BYTES} bytes` }, 413)
      }
      writeEnv(deployId, merged)
      const quota = controlDb.getQuota(deployId)
      const sizeAfter = dirSize(deployDirFor(deployId))
      if (sizeAfter > quota.maxDiskBytes) {
        return c.json({ error: `Disk usage ${sizeAfter} exceeds quota ${quota.maxDiskBytes}` }, 413)
      }
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      try {
        await forkDeploy(r.record)
      } catch (err: any) {
        return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
      }
      const envActor = authUser(c)
      if (envActor) {
        audit(actorFor(envActor, false), "deploy.env_update", {
          targetDeployId: deployId,
          metadata: { keys: Object.keys(incoming) },
        })
      }
      return c.json({ entries: merged })
    })

    app.delete("/api/deploys/:deployId/env/:key", async (c) => {
      const deployId = c.req.param("deployId")
      const key = c.req.param("key")
      const r = requireDeployOwner(c, deployId)
      if (r instanceof Response) return r
      const entries = readEnv(deployId)
      if (!(key in entries)) return c.json({ entries })
      delete entries[key]
      writeEnv(deployId, entries)
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      try {
        await forkDeploy(r.record)
      } catch (err: any) {
        return c.json({ error: `Boot failed: ${err?.message ?? err}` }, 500)
      }
      const envActor = authUser(c)
      if (envActor) {
        audit(actorFor(envActor, false), "deploy.env_delete", {
          targetDeployId: deployId,
          metadata: { key },
        })
      }
      return c.json({ entries })
    })

    // ---- SOURCE FILES (IDE) ----

    const FILE_PATH_RE = /^(?:(server|client|shared)\/[a-zA-Z0-9_./-]+|package\.json)$/
    const MAX_FILE_BYTES = 1 * 1024 * 1024

    function safeSourcePath(deployId: string, requested: string): string | null {
      if (!requested || requested.includes("\\") || requested.startsWith("/")) return null
      const segments = requested.split("/")
      if (segments.some((s) => s === ".." || s === "." || s === "")) return null
      if (!FILE_PATH_RE.test(requested)) return null
      const sourceDir = path.join(deployDirFor(deployId), "source")
      const abs = path.join(sourceDir, requested)
      // belt + suspenders: ensure resolved path is still inside sourceDir
      if (!abs.startsWith(sourceDir + path.sep) && abs !== sourceDir) return null
      return abs
    }

    function fileSubpath(c: any, deployId: string): string | null {
      const prefix = `/api/deploys/${deployId}/files/`
      const url = new URL(c.req.url)
      let decoded: string
      try {
        decoded = decodeURIComponent(url.pathname)
      } catch {
        return null
      }
      if (!decoded.startsWith(prefix)) return null
      return decoded.slice(prefix.length)
    }

    function listSourceTree(deployId: string): { path: string; size: number; mtime: string }[] {
      const sourceDir = path.join(deployDirFor(deployId), "source")
      if (!fs.existsSync(sourceDir)) return []
      const out: { path: string; size: number; mtime: string }[] = []
      const walk = (rel: string) => {
        const abs = path.join(sourceDir, rel)
        const stat = fs.statSync(abs)
        if (stat.isFile()) {
          out.push({ path: rel, size: stat.size, mtime: stat.mtime.toISOString() })
          return
        }
        if (stat.isDirectory()) {
          for (const entry of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${entry}` : entry)
        }
      }
      for (const entry of fs.readdirSync(sourceDir).sort()) walk(entry)
      return out
    }

    function authorizeFileOp(c: any, deployId: string): { record: HostedDeployRecord } | Response {
      const record = readRecord(deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      if (controlDb.findAnonymous(deployId)) {
        return c.json({ error: "Anonymous deploys cannot be edited — claim first" }, 403)
      }
      const auth = authorizeDeployMutation(c, record)
      if (auth instanceof Response) return auth
      return { record }
    }

    app.get("/api/deploys/:deployId/files", (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      return c.json({ files: listSourceTree(deployId) })
    })

    app.get("/api/deploys/:deployId/files/*", (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      const sub = fileSubpath(c, deployId)
      if (!sub) return c.json({ error: "Invalid path" }, 400)
      const abs = safeSourcePath(deployId, sub)
      if (!abs) return c.json({ error: "Path not allowed" }, 400)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return c.json({ error: "Not found" }, 404)
      return c.body(fs.readFileSync(abs), 200, { "content-type": "text/plain; charset=utf-8" })
    })

    app.put(
      "/api/deploys/:deployId/files/*",
      bodyLimit({ maxSize: MAX_FILE_BYTES, onError: (c) => c.json({ error: "File too large" }, 413) }),
      async (c) => {
        const deployId = c.req.param("deployId")
        const r = authorizeFileOp(c, deployId)
        if (r instanceof Response) return r
        const sub = fileSubpath(c, deployId)
        if (!sub) return c.json({ error: "Invalid path" }, 400)
        const abs = safeSourcePath(deployId, sub)
        if (!abs) return c.json({ error: "Path not allowed" }, 400)
        const body = await c.req.text()
        if (Buffer.byteLength(body, "utf-8") > MAX_FILE_BYTES) {
          return c.json({ error: `File exceeds ${MAX_FILE_BYTES} bytes` }, 413)
        }
        // Same rule as the bulk source endpoint: package.json can't define
        // npm lifecycle scripts (preinstall/install/postinstall/prepare/
        // postprepare). Caught here too because IDE single-file PUT bypasses
        // validateSourceFiles entirely.
        if (sub === "package.json") {
          const lifecycle = findPackageJsonLifecycleScripts(body)
          if (!lifecycle.ok) {
            return c.json(
              {
                error: `package.json defines npm lifecycle script(s) ${lifecycle.offending.join(", ")} which are not allowed on hosted deploys`,
              },
              400,
            )
          }
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, body)
        r.record.updatedAt = new Date().toISOString()
        writeRecord(r.record)
        const fileActor = authUser(c)
        audit(fileActor ? actorFor(fileActor, false) : "__claim_token__", "deploy.file_write", {
          targetDeployId: deployId,
          metadata: { path: sub, bytes: Buffer.byteLength(body, "utf-8") },
        })
        return c.json({ ok: true, path: sub, size: Buffer.byteLength(body, "utf-8") })
      },
    )

    app.delete("/api/deploys/:deployId/files/*", (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      const sub = fileSubpath(c, deployId)
      if (!sub) return c.json({ error: "Invalid path" }, 400)
      if (sub === "server/index.ts" || sub === "package.json") {
        return c.json({ error: "Cannot delete required file" }, 400)
      }
      const abs = safeSourcePath(deployId, sub)
      if (!abs) return c.json({ error: "Path not allowed" }, 400)
      if (!fs.existsSync(abs)) return c.json({ ok: true })
      fs.rmSync(abs, { force: true })
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      const fileActor = authUser(c)
      audit(fileActor ? actorFor(fileActor, false) : "__claim_token__", "deploy.file_delete", {
        targetDeployId: deployId,
        metadata: { path: sub },
      })
      return c.json({ ok: true })
    })

    app.post("/api/deploys/:deployId/build", async (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      const dir = deployDirFor(deployId)
      if (!fs.existsSync(path.join(dir, "source", "server", "index.ts"))) {
        return c.json({ ok: false, errors: [{ text: "source/server/index.ts missing on host" }] }, 200)
      }
      const start = Date.now()
      let result: {
        bundleBytes: number
        bundleHash: string
        meta: { isPublic: boolean; title?: string; description?: string }
      }
      try {
        result = await buildDeployFromSource(dir)
      } catch (err: any) {
        // esbuild throws a BuildFailure with .errors[] on compile error
        const messages: { file?: string; line?: number; column?: number; text: string }[] = []
        const raw = Array.isArray(err?.errors) ? err.errors : null
        if (raw) {
          for (const m of raw) {
            messages.push({
              file: m?.location?.file,
              line: m?.location?.line,
              column: m?.location?.column,
              text: String(m?.text ?? "unknown error"),
            })
          }
        } else {
          messages.push({ text: String(err?.message ?? err) })
        }
        return c.json({ ok: false, errors: messages, durationMs: Date.now() - start }, 200)
      }
      const quota = controlDb.getQuota(deployId)
      if (result.bundleBytes > quota.maxBundleBytes) {
        return c.json(
          { ok: false, errors: [{ text: `Bundle exceeds per-deploy quota (${quota.maxBundleBytes} bytes)` }] },
          200,
        )
      }
      const buildNow = new Date().toISOString()
      const buildDuration = Date.now() - start
      r.record.updatedAt = buildNow
      r.record.isPublic = result.meta.isPublic
      r.record.title = result.meta.title
      r.record.description = result.meta.description
      r.record.bundleBytes = result.bundleBytes
      r.record.bundleHash = result.bundleHash
      r.record.lastBuiltAt = buildNow
      r.record.lastBuildDurationMs = buildDuration
      writeRecord(r.record)
      try {
        await forkDeploy(r.record)
      } catch (err: any) {
        return c.json({ ok: false, errors: [{ text: `Boot failed: ${err?.message ?? err}` }] }, 200)
      }
      const buildActor = authUser(c)
      audit(buildActor ? actorFor(buildActor, false) : "__claim_token__", "deploy.rebuild", {
        targetDeployId: deployId,
        metadata: { bundleBytes: result.bundleBytes, durationMs: buildDuration },
      })
      return c.json({
        ok: true,
        bundleBytes: result.bundleBytes,
        bundleHash: result.bundleHash,
        durationMs: buildDuration,
      })
    })

    app.post("/api/deploys/:deployId/files/move", async (c) => {
      const deployId = c.req.param("deployId")
      const r = authorizeFileOp(c, deployId)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => null)) as { from?: unknown; to?: unknown } | null
      if (!body || typeof body.from !== "string" || typeof body.to !== "string") {
        return c.json({ error: "from + to required" }, 400)
      }
      if (body.from === "server/index.ts" || body.from === "package.json") {
        return c.json({ error: "Cannot move required file" }, 400)
      }
      const fromAbs = safeSourcePath(deployId, body.from)
      const toAbs = safeSourcePath(deployId, body.to)
      if (!fromAbs || !toAbs) return c.json({ error: "Path not allowed" }, 400)
      if (!fs.existsSync(fromAbs)) return c.json({ error: "Source not found" }, 404)
      if (fs.existsSync(toAbs)) return c.json({ error: "Destination exists" }, 409)
      fs.mkdirSync(path.dirname(toAbs), { recursive: true })
      fs.renameSync(fromAbs, toAbs)
      r.record.updatedAt = new Date().toISOString()
      writeRecord(r.record)
      const fileActor = authUser(c)
      audit(fileActor ? actorFor(fileActor, false) : "__claim_token__", "deploy.file_move", {
        targetDeployId: deployId,
        metadata: { from: body.from, to: body.to },
      })
      return c.json({ ok: true })
    })

    // ---- PUBLIC GALLERY + FORK ----

    // Unauthenticated. Lists deploys whose capsule declared `public: true` in
    // its last build. Anonymous deploys are excluded — there's no "owner" to
    // attribute them to, and they have a short retention window.
    // publicListingCache + invalidatePublicListing are declared up top (next
    // to writeRecord) — see comment there. The handler below closes over
    // those bindings.
    app.get("/api/public-deploys", (c) => {
      const now = Date.now()
      if (publicListingCache && publicListingCache.expiresAt > now) {
        return c.json(publicListingCache.body)
      }
      const out: Array<{
        deployId: string
        url: string
        title?: string
        description?: string
        createdAt: string
      }> = []
      const ids = fs
        .readdirSync(deploysDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
      for (const id of ids) {
        const rec = readRecord(id)
        if (!rec?.isPublic) continue
        if (controlDb.findAnonymous(id)) continue
        out.push({
          deployId: rec.deployId,
          url: rec.url,
          title: rec.title,
          description: rec.description,
          createdAt: rec.createdAt,
        })
      }
      out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      const body = { deploys: out }
      publicListingCache = { body, expiresAt: now + PUBLIC_LISTING_TTL_MS }
      return c.json(body)
    })

    // Returns all source files for a public capsule as { path: content } so
    // `pond fork` can scaffold a copy. Owner-private deploys 404 here even
    // if they exist — non-public capsules don't show up in any listing and
    // their source is unreachable through this surface.
    app.get("/api/public-deploys/:deployId/source", (c) => {
      const deployId = c.req.param("deployId")
      const rec = readRecord(deployId)
      if (!rec?.isPublic) return c.json({ error: "Not found" }, 404)
      const sourceDir = path.join(deployDirFor(deployId), "source")
      if (!fs.existsSync(sourceDir)) return c.json({ error: "Not found" }, 404)
      const files: Record<string, string> = {}
      const walk = (rel: string) => {
        const abs = path.join(sourceDir, rel)
        const stat = fs.statSync(abs)
        if (stat.isDirectory()) {
          for (const entry of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${entry}` : entry)
        } else if (stat.isFile()) {
          // 1 MB per file ceiling — same as the IDE
          if (stat.size > 1 * 1024 * 1024) return
          files[rel] = fs.readFileSync(abs, "utf-8")
        }
      }
      for (const entry of fs.readdirSync(sourceDir).sort()) walk(entry)
      return c.json({
        deployId,
        title: rec.title,
        description: rec.description,
        files,
      })
    })

    // ---- CUSTOM DOMAINS ----

    app.get("/api/domains", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const rows =
        r.user.isAdmin === 1
          ? fs
              .readdirSync(deploysDir, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .flatMap((e) =>
                controlDb
                  .listDomainsForDeploy(e.name)
                  .map((d) => ({ subdomain: d.subdomain, deployId: e.name, createdAt: d.createdAt })),
              )
          : controlDb.listDomainsForUser(r.user.id)
      return c.json({ domains: rows })
    })

    app.post("/api/domains", async (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const body = (await c.req.json().catch(() => ({}))) as { subdomain?: unknown; deployId?: unknown }
      if (typeof body.subdomain !== "string" || typeof body.deployId !== "string") {
        return c.json({ error: "subdomain and deployId required" }, 400)
      }
      const sub = body.subdomain
      if (!SUBDOMAIN_LABEL_RE.test(sub) || sub.length > 63) {
        return c.json(
          { error: "invalid subdomain (DNS label rules: a-z, 0-9, hyphens; max 63; no leading/trailing hyphen)" },
          400,
        )
      }
      if (RESERVED_SUBDOMAINS.has(sub)) {
        return c.json({ error: `subdomain "${sub}" is reserved` }, 400)
      }
      if (HEX_DEPLOY_ID_RE.test(sub)) {
        return c.json({ error: "subdomain may not be a 16-char hex string (collides with deployId routing)" }, 400)
      }
      const record = readRecord(body.deployId)
      if (!record) return c.json({ error: "Not found" }, 404)
      const ownerId = controlDb.getDeployOwner(body.deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      if (r.user.isAdmin !== 1 && controlDb.countDomainsForUser(r.user.id) >= MAX_DOMAINS_PER_USER) {
        return c.json({ error: `domain limit reached (${MAX_DOMAINS_PER_USER} per user)` }, 429)
      }
      try {
        controlDb.addDomain(sub, body.deployId)
      } catch (err: any) {
        if (String(err?.code ?? "").includes("SQLITE_CONSTRAINT")) {
          return c.json({ error: "subdomain already taken" }, 409)
        }
        throw err
      }
      const row = controlDb.findDomain(sub)
      audit(actorFor(r.user, false), "domain.add", {
        targetDeployId: body.deployId,
        metadata: { subdomain: sub },
      })
      return c.json(
        {
          subdomain: sub,
          deployId: body.deployId,
          createdAt: row?.createdAt,
          url: urlForCustomDomain(sub),
        },
        201,
      )
    })

    app.delete("/api/domains/:subdomain", (c) => {
      const r = requireUser(c)
      if (r instanceof Response) return r
      const sub = c.req.param("subdomain").toLowerCase()
      const row = controlDb.findDomain(sub)
      if (!row) return c.json({ error: "Not found" }, 404)
      const ownerId = controlDb.getDeployOwner(row.deployId)
      if (r.user.isAdmin !== 1 && ownerId !== r.user.id) {
        return c.json({ error: "Forbidden" }, 403)
      }
      controlDb.removeDomain(sub)
      audit(actorFor(r.user, false), "domain.remove", {
        targetDeployId: row.deployId,
        metadata: { subdomain: sub },
      })
      return c.json({ ok: true })
    })

    const HOP_BY_HOP = new Set([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "host",
    ])
    function deployIdFromHost(hostHeader: string | undefined): string | null {
      if (!hostHeader) return null
      const bare = hostHeader.toLowerCase().split(":")[0]
      const dot = bare.indexOf(".")
      if (dot <= 0) return null
      const sub = bare.slice(0, dot)
      if (HEX_DEPLOY_ID_RE.test(sub)) return sub
      const domain = controlDb.findDomain(sub)
      return domain?.deployId ?? null
    }

    function isBareDomainRequest(hostHeader: string | undefined): boolean {
      if (!hostHeader) return false
      const bare = hostHeader.toLowerCase().split(":")[0]
      return bare === externalHost || bare === `www.${externalHost}`
    }

    function landingHtml(): string {
      const installCmd = "npm install -g pondsh"
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pond</title>
<meta name="description" content="Agent-native full-stack TypeScript capsules." />
<style>
  :root {
    --bg: #000;
    --text: #f5f5f5;
    --muted: #aaa;
    --line: #242424;
    --code-bg: #080808;
    --code: #ededed;
    --link: #8ab4ff;
    --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html { min-height: 100%; background: var(--bg); color: var(--text); font-family: var(--sans); }
  body { min-height: 100vh; margin: 0; background: var(--bg); }
  main {
    display: flex;
    min-height: 100vh;
    width: min(720px, calc(100vw - 40px));
    margin: 0 auto;
    padding: 88px 0;
    align-items: center;
  }
  .content { width: 100%; }
  h1 {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 14px;
    margin: 0 0 18px;
    color: var(--text);
    font-size: 72px;
    line-height: 0.94;
    letter-spacing: 0;
  }
  .alpha-mark {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 0.34em;
    font-weight: 500;
    line-height: 1;
  }
  p {
    max-width: 620px;
    margin: 0;
    color: var(--muted);
    font-size: 21px;
    line-height: 1.45;
  }
  .command-button {
    display: flex;
    width: 100%;
    min-height: 64px;
    margin: 40px 0 28px;
    padding: 18px 20px;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    border: 1px solid var(--line);
    background: var(--code-bg);
    color: var(--code);
    font-family: var(--mono);
    font-size: 16px;
    line-height: 1.5;
    text-align: left;
    cursor: pointer;
  }
  .command-button:hover, .command-button:focus-visible { border-color: #4a4a4a; }
  .command-button:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
  code { font-family: inherit; }
  .copy-state {
    flex: 0 0 auto;
    color: var(--muted);
    font-family: var(--sans);
    font-size: 14px;
  }
  a {
    color: var(--link);
    font-size: 17px;
    text-decoration-thickness: 1px;
    text-underline-offset: 4px;
  }
  .links { display: flex; flex-wrap: wrap; gap: 22px; }
  .fine {
    margin-top: 28px;
    color: #5a5a5a;
    font-size: 13px;
    line-height: 1.5;
  }
  .fine a { color: #7a7a7a; font-size: 13px; }
  @media (max-width: 640px) {
    main { width: min(100vw - 28px, 720px); padding: 48px 0; align-items: flex-start; }
    p { font-size: 18px; }
    h1 { font-size: 44px; }
    .command-button { margin-top: 34px; font-size: 15px; }
  }
</style>
</head>
<body>
<main>
  <div class="content">
    <h1>pond <span class="alpha-mark">[alpha]</span></h1>
    <p>Agent-native full-stack TypeScript capsules. Deploy anonymously.</p>
    <button class="command-button" type="button" data-command="${installCmd}" aria-label="Copy ${installCmd}">
      <code>${installCmd}</code>
      <span class="copy-state" aria-live="polite">Copy</span>
    </button>
    <div class="links">
      <a href="/docs">Docs</a>
      <a href="https://github.com/DevvGwardo/pond" rel="noreferrer">GitHub</a>
    </div>
    <p class="fine">
      Anonymous deploys are sandboxed and may be terminated at any time. <a href="/abuse">Abuse policy</a> · <a href="/.well-known/security.txt">Security</a>
    </p>
  </div>
</main>
<script>
  const commandButton = document.querySelector(".command-button");
  const copyState = document.querySelector(".copy-state");
  async function copyText(value) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (copied) return;
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    throw new Error("Unable to copy command.");
  }
  commandButton.addEventListener("click", async () => {
    const command = commandButton.dataset.command;
    try {
      await copyText(command);
      copyState.textContent = "Copied";
    } catch {
      copyState.textContent = "Copy failed";
    }
    window.setTimeout(() => { copyState.textContent = "Copy"; }, 1400);
  });
</script>
</body>
</html>`
    }

    function galleryHtml(): string {
      // Tiny client-side renderer: hits /api/public-deploys + draws cards.
      // No bundler, no SPA — the page is one HTML file and 30 lines of inline JS.
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Pond Gallery</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/favicon.svg" />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #09090b; color: #e4e4e7; font-family: ui-sans-serif, system-ui, sans-serif; }
  header { padding: 32px 24px 16px; max-width: 980px; margin: 0 auto; }
  h1 { margin: 0; font-size: 22px; }
  p.lede { color: #a1a1aa; font-size: 14px; margin-top: 4px; }
  main { max-width: 980px; margin: 0 auto; padding: 16px 24px 48px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  article { background: #18181b; border: 1px solid #27272a; border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  article h2 { margin: 0; font-size: 15px; }
  article p { color: #a1a1aa; font-size: 13px; margin: 0; flex: 1; }
  .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; font-size: 11px; color: #71717a; }
  a.btn { color: #09090b; background: #fafafa; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; text-decoration: none; }
  a.btn:hover { background: #e4e4e7; }
  a.ghost { color: #d4d4d8; padding: 6px 10px; border: 1px solid #3f3f46; border-radius: 6px; font-size: 12px; text-decoration: none; }
  .empty { color: #71717a; padding: 24px; text-align: center; grid-column: 1 / -1; }
</style>
</head>
<body>
<header>
  <h1>Pond gallery</h1>
  <p class="lede">Capsules whose authors opted into <code>capsule({ public: true })</code>. Fork to spin up your own copy.</p>
</header>
<main id="grid"><div class="empty">Loading…</div></main>
<script>
(async () => {
  const grid = document.getElementById("grid");
  try {
    const r = await fetch("/api/public-deploys");
    const { deploys } = await r.json();
    if (!deploys.length) { grid.innerHTML = '<div class="empty">No public capsules yet.</div>'; return; }
    grid.innerHTML = "";
    for (const d of deploys) {
      const card = document.createElement("article");
      card.innerHTML = \`
        <h2>\${escapeHtml(d.title || d.deployId)}</h2>
        <p>\${escapeHtml(d.description || "")}</p>
        <div class="row">
          <span>\${new Date(d.createdAt).toLocaleDateString()}</span>
          <div style="display:flex;gap:6px;">
            <a class="ghost" href="\${d.url}" target="_blank" rel="noreferrer">Open</a>
            <a class="btn" href="\${d.url}" onclick="navigator.clipboard.writeText('pond fork ' + this.href); this.textContent='Copied ✓'; setTimeout(()=>this.textContent='Fork',1400); event.preventDefault();">Fork</a>
          </div>
        </div>\`;
      grid.appendChild(card);
    }
  } catch (err) {
    grid.innerHTML = '<div class="empty">Failed to load: ' + escapeHtml(String(err)) + '</div>';
  }
})();
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
</script>
</body>
</html>`
    }

    // Shared CSS + chrome for the /docs surface. Same palette / type as
    // landingHtml() — black, mono accents, no rounded corners, no rainbow
    // code highlighting. The sidebar collapses to a top-bar <details> on
    // mobile via media query, no JS.
    function docsChrome(opts: { title: string; activeSlug: string | null; bodyHtml: string }): string {
      const navItems = DOCS_CATALOG.map(
        (d) =>
          `<li><a href="/docs/${d.slug}" ${d.slug === opts.activeSlug ? 'class="current" aria-current="page"' : ""}>${htmlEscape(d.title)}</a></li>`,
      ).join("\n          ")
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${htmlEscape(opts.title)}</title>
<meta name="description" content="Pond documentation — CLI, server API, client API, MCP, operations." />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<style>
  :root {
    --bg: #000;
    --bg-elev: #050505;
    --text: #f5f5f5;
    --muted: #aaa;
    --subtle: #5a5a5a;
    --line: #242424;
    --line-soft: #161616;
    --code-bg: #080808;
    --code: #ededed;
    --link: #8ab4ff;
    --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
  body { min-height: 100vh; }
  a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  a:hover { text-decoration-thickness: 2px; }

  .topbar {
    border-bottom: 1px solid var(--line);
    padding: 18px 28px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .topbar a { color: var(--muted); text-decoration: none; }
  .topbar a:hover { color: var(--text); }
  .topbar .sep { color: var(--subtle); margin: 0 8px; }

  .layout {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    max-width: 1100px;
    margin: 0 auto;
    padding: 48px 28px 96px;
    gap: 56px;
  }

  aside.nav {
    position: sticky;
    top: 32px;
    align-self: start;
    border-right: 1px solid var(--line-soft);
    padding-right: 24px;
  }
  aside.nav h2 {
    margin: 0 0 14px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--subtle);
    text-transform: uppercase;
    font-weight: 500;
  }
  aside.nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  aside.nav a {
    display: block;
    padding: 6px 0;
    color: var(--muted);
    text-decoration: none;
    font-size: 14px;
    border-left: 2px solid transparent;
    padding-left: 10px;
    margin-left: -10px;
    transition: color 120ms ease, border-color 120ms ease;
  }
  aside.nav a:hover { color: var(--text); }
  aside.nav a.current { color: var(--text); border-left-color: var(--text); }
  aside.nav .external { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 8px; font-size: 13px; }

  main.doc { min-width: 0; }
  main.doc h1 {
    margin: 0 0 28px;
    font-size: 44px;
    line-height: 1.05;
    letter-spacing: -0.01em;
    font-weight: 700;
  }
  main.doc h2 {
    margin: 56px 0 14px;
    padding-top: 16px;
    border-top: 1px solid var(--line-soft);
    font-size: 22px;
    letter-spacing: -0.005em;
    font-weight: 600;
  }
  main.doc h3 { margin: 36px 0 12px; font-size: 17px; font-weight: 600; }
  main.doc h4 { margin: 28px 0 10px; font-size: 14px; font-weight: 600; font-family: var(--mono); color: var(--muted); letter-spacing: 0.04em; text-transform: uppercase; }
  main.doc p, main.doc li { font-size: 15px; line-height: 1.65; color: var(--text); }
  main.doc p { margin: 0 0 16px; }
  main.doc ul, main.doc ol { padding-left: 22px; margin: 0 0 18px; }
  main.doc li { margin: 4px 0; }
  main.doc strong { color: var(--text); font-weight: 600; }
  main.doc hr { border: 0; border-top: 1px solid var(--line); margin: 40px 0; }

  main.doc :is(h1, h2, h3, h4, h5, h6) .anchor {
    color: var(--subtle);
    text-decoration: none;
    margin-right: 10px;
    font-weight: 400;
    opacity: 0;
    transition: opacity 120ms ease;
  }
  main.doc :is(h1, h2, h3, h4, h5, h6):hover .anchor { opacity: 1; }
  main.doc :is(h1, h2, h3, h4, h5, h6) .anchor:hover { color: var(--text); }

  main.doc code {
    font-family: var(--mono);
    font-size: 0.875em;
    background: var(--code-bg);
    border: 1px solid var(--line);
    padding: 1px 6px;
    color: var(--code);
  }
  main.doc pre {
    margin: 18px 0 22px;
    padding: 16px 18px;
    background: var(--code-bg);
    border: 1px solid var(--line);
    overflow-x: auto;
    font-size: 13.5px;
    line-height: 1.55;
  }
  main.doc pre code { background: transparent; border: 0; padding: 0; font-size: inherit; color: var(--code); }

  main.doc blockquote {
    margin: 18px 0;
    padding: 12px 18px;
    border-left: 2px solid var(--muted);
    color: var(--muted);
    background: var(--bg-elev);
  }
  main.doc blockquote p { margin: 0; color: inherit; }

  main.doc table {
    width: 100%;
    border-collapse: collapse;
    margin: 18px 0 24px;
    font-size: 14px;
    border: 1px solid var(--line);
  }
  main.doc th, main.doc td {
    text-align: left;
    padding: 9px 14px;
    border-bottom: 1px solid var(--line-soft);
    vertical-align: top;
  }
  main.doc th {
    font-weight: 600;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--bg-elev);
  }
  main.doc td code { white-space: nowrap; }
  main.doc tr:last-child td { border-bottom: 0; }

  main.doc :target { scroll-margin-top: 80px; }

  .footer-meta {
    margin-top: 64px;
    padding-top: 18px;
    border-top: 1px solid var(--line-soft);
    color: var(--subtle);
    font-size: 12px;
    font-family: var(--mono);
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }
  .footer-meta a { color: var(--subtle); }
  .footer-meta a:hover { color: var(--muted); }

  @media (max-width: 820px) {
    .layout { grid-template-columns: 1fr; padding: 24px 20px 64px; gap: 24px; }
    aside.nav { position: static; border-right: 0; padding-right: 0; border-bottom: 1px solid var(--line-soft); padding-bottom: 18px; }
    aside.nav h2 { margin-bottom: 8px; }
    aside.nav ul { flex-direction: row; flex-wrap: wrap; gap: 4px 14px; }
    aside.nav a { padding: 4px 0; margin-left: 0; padding-left: 0; border-left: 0; border-bottom: 2px solid transparent; }
    aside.nav a.current { border-left: 0; border-bottom-color: var(--text); }
    aside.nav .external { flex-direction: row; gap: 16px; }
    main.doc h1 { font-size: 34px; }
    main.doc h2 { font-size: 19px; }
    main.doc pre { padding: 12px 14px; font-size: 12.5px; }
    .topbar { padding: 14px 20px; }
  }
</style>
</head>
<body>
<nav class="topbar">
  <a href="/">pond</a><span class="sep">/</span><a href="/docs">docs</a>${
    opts.activeSlug ? `<span class="sep">/</span><span>${htmlEscape(opts.activeSlug)}</span>` : ""
  }
</nav>
<div class="layout">
  <aside class="nav">
    <h2>Reference</h2>
    <ul>
          ${navItems}
    </ul>
    <div class="external">
      <a href="/">Home</a>
      <a href="https://github.com/DevvGwardo/pond" rel="noreferrer">GitHub</a>
      <a href="/llms-full.txt">llms-full.txt</a>
    </div>
  </aside>
  <main class="doc">
${opts.bodyHtml}
    <div class="footer-meta">
      ${opts.activeSlug ? `<span>source: <a href="/docs/${opts.activeSlug}.md">/docs/${opts.activeSlug}.md</a></span>` : ""}
      <span><a href="https://github.com/DevvGwardo/pond/blob/main/docs/${opts.activeSlug ?? ""}${opts.activeSlug ? ".md" : ""}" rel="noreferrer">Edit on GitHub</a></span>
    </div>
  </main>
</div>
</body>
</html>`
    }

    function docsIndexHtml(): string {
      const cards = DOCS_CATALOG.map(
        (d) => `
      <a class="card" href="/docs/${d.slug}">
        <span class="card-eyebrow">${htmlEscape(d.slug)}</span>
        <h2>${htmlEscape(d.title)}</h2>
        <p>${htmlEscape(d.summary)}</p>
      </a>`,
      ).join("")
      const body = `
    <p class="doc-eyebrow">pond / docs</p>
    <h1>Everything pond can do.</h1>
    <p class="lede">Five short references. The CLI and the runtime, the MCP server, and the operations guide for when you outgrow a laptop.</p>
    <style>
      main.doc .doc-eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--subtle); margin: 0 0 16px; }
      main.doc .lede { font-size: 18px; color: var(--muted); line-height: 1.5; margin-bottom: 40px; max-width: 580px; }
      main.doc .cards { display: grid; grid-template-columns: 1fr; gap: 0; border-top: 1px solid var(--line-soft); }
      main.doc .card { display: block; padding: 22px 0; border-bottom: 1px solid var(--line-soft); text-decoration: none; color: inherit; transition: padding-left 160ms ease; }
      main.doc .card:hover { padding-left: 10px; }
      main.doc .card-eyebrow { display: inline-block; margin-bottom: 6px; font-family: var(--mono); font-size: 11px; color: var(--subtle); letter-spacing: 0.12em; text-transform: uppercase; }
      main.doc .card h2 { margin: 0 0 6px; padding: 0; border: 0; font-size: 22px; font-weight: 600; }
      main.doc .card p { margin: 0; color: var(--muted); font-size: 14.5px; line-height: 1.5; max-width: 620px; }
    </style>
    <div class="cards">${cards}
    </div>
`
      return docsChrome({ title: "Docs · Pond", activeSlug: null, bodyHtml: body })
    }

    function docsPageHtml(slug: string, markdown: string): string | null {
      const meta = DOCS_CATALOG.find((d) => d.slug === slug)
      if (!meta) return null
      const body = renderMarkdown(markdown)
      return docsChrome({
        title: `${meta.title} · Pond docs`,
        activeSlug: slug,
        bodyHtml: body,
      })
    }

    function abuseHtml(): string {
      const contact = abuseEmail ? `<a href="mailto:${abuseEmail}">${abuseEmail}</a>` : "the host operator"
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Pond — Abuse Policy</title>
<style>
  body { margin: 0; background: #09090b; color: #e4e4e7; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; line-height: 1.6; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 32px; margin: 0 0 24px; }
  h2 { font-size: 18px; margin: 28px 0 8px; color: #d4d4d8; }
  a { color: #a5f3fc; }
  p, li { color: #d4d4d8; }
  ul { padding-left: 22px; }
</style>
</head>
<body>
<main>
  <h1>Abuse policy</h1>
  <p>Pond hosts arbitrary user-submitted capsules anonymously. To keep this service usable, the following are prohibited:</p>
  <ul>
    <li>Phishing, credential harvesting, or impersonation of any third party.</li>
    <li>Malware distribution, drive-by downloads, exploit kits.</li>
    <li>Cryptocurrency mining, brute force / credential stuffing, or any abuse of compute resources.</li>
    <li>Spam, scams, illegal content under the jurisdiction of the host operator.</li>
    <li>Targeted harassment or doxing.</li>
  </ul>
  <h2>Reporting abuse</h2>
  <p>Email ${contact} with the deploy URL and a description of the issue. The host operator may take down any deploy at any time without notice. There is no SLA.</p>
  <h2>Service limits</h2>
  <p>Anonymous deploys: 16 MB bundle, 128 MB disk, 128 MB memory, 1 hour grace before termination, 7 days before deletion, 5 deploys per IP per hour. Outbound network access is restricted at the JavaScript layer for anonymous deploys.</p>
  <h2>No warranty</h2>
  <p>Pond is provided as-is. The host operator makes no guarantees of availability, durability, or fitness for any purpose. Do not deploy production workloads.</p>
  <p style="margin-top:36px;"><a href="/">← back</a></p>
</main>
</body>
</html>`
    }

    function securityTxt(): string {
      const contact = abuseEmail
        ? `Contact: mailto:${abuseEmail}`
        : "Contact: (set POND_ABUSE_EMAIL to populate this field)"
      const oneYearOut = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      return `${contact}
Expires: ${oneYearOut}T00:00:00.000Z
Preferred-Languages: en
Canonical: ${publicBaseUrl ? publicBaseUrl.toString().replace(/\/$/, "") : `http://${publicHost}:${port}`}/.well-known/security.txt
`
    }

    app.all("*", async (c) => {
      // Bare-domain requests (no subdomain) — serve the marketing / policy pages.
      if (isBareDomainRequest(c.req.header("host"))) {
        const url = new URL(c.req.url)
        if (c.req.method === "GET") {
          if (url.pathname === "/" || url.pathname === "") {
            return c.html(landingHtml())
          }
          if (url.pathname === "/abuse") {
            return c.html(abuseHtml())
          }
          if (url.pathname === "/.well-known/security.txt") {
            return new Response(securityTxt(), {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })
          }
          if (url.pathname === "/robots.txt") {
            return new Response("User-agent: *\nAllow: /\n", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })
          }
          if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#09090b"/><path d="M16 6c-3 5-7 9-7 13a7 7 0 0 0 14 0c0-4-4-8-7-13z" fill="#67e8f9"/></svg>`
            return new Response(svg, {
              status: 200,
              headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
            })
          }
          if (url.pathname === "/llms.txt" || url.pathname === "/llms-full.txt") {
            const filename = url.pathname.slice(1)
            const abs = path.join(pondDocsDir, filename)
            if (fs.existsSync(abs)) {
              return new Response(fs.readFileSync(abs), {
                status: 200,
                headers: {
                  "content-type": "text/plain; charset=utf-8",
                  "cache-control": "public, max-age=300",
                },
              })
            }
            return c.json({ error: "Not found" }, 404)
          }
          // Human-readable docs index. /docs and /docs/ both land here.
          if (url.pathname === "/docs" || url.pathname === "/docs/") {
            return c.html(docsIndexHtml())
          }
          // Human-readable docs page. /docs/<slug> with no .md suffix renders
          // the markdown to HTML. We deliberately fall through to the raw-
          // markdown handler below for /docs/<slug>.md so agents (and llms.txt)
          // keep working unchanged.
          const docHtmlMatch = url.pathname.match(/^\/docs\/([a-z0-9_-]+)\/?$/)
          if (docHtmlMatch) {
            const slug = docHtmlMatch[1]
            if (!DOCS_SLUG_RE.test(slug)) return c.json({ error: "Not found" }, 404)
            const abs = path.join(pondDocsDir, `${slug}.md`)
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
              const rendered = docsPageHtml(slug, fs.readFileSync(abs, "utf-8"))
              if (rendered) return c.html(rendered)
            }
            return c.json({ error: "Not found" }, 404)
          }
          const docMatch = url.pathname.match(/^\/docs\/([a-zA-Z0-9_-]+\.md)$/)
          if (docMatch) {
            const abs = path.join(pondDocsDir, docMatch[1])
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
              return new Response(fs.readFileSync(abs), {
                status: 200,
                headers: {
                  "content-type": "text/markdown; charset=utf-8",
                  "cache-control": "public, max-age=300",
                },
              })
            }
            return c.json({ error: "Not found" }, 404)
          }
          if (url.pathname === "/gallery") {
            return c.html(galleryHtml())
          }
          if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
            const bootstrap = JSON.stringify({ controlUrl: apiUrl, publicHost })
            const html = dashboardHtml.replace(
              "__POND_DASHBOARD__BOOTSTRAP__",
              `window.__POND_DASHBOARD = ${bootstrap}`,
            )
            return c.html(html)
          }
          const ideMatch = url.pathname.match(/^\/ide\/([a-f0-9]+)\/?$/)
          if (ideMatch) {
            const deployId = ideMatch[1]
            const record = readRecord(deployId)
            if (!record) return c.json({ error: "Unknown deploy" }, 404)
            // Send the last successful build (if any) so the IDE's
            // diagnostics panel renders `✓ Built · 17.4 KB` on first mount
            // instead of "No build yet". Older records that pre-date these
            // fields simply omit `lastBuild` and the IDE falls back to the
            // unbuilt placeholder, which is honest for them.
            const lastBuild =
              typeof record.bundleBytes === "number" &&
              typeof record.bundleHash === "string" &&
              typeof record.lastBuiltAt === "string"
                ? {
                    bundleBytes: record.bundleBytes,
                    bundleHash: record.bundleHash,
                    builtAt: record.lastBuiltAt,
                    durationMs: record.lastBuildDurationMs ?? 0,
                  }
                : null
            const bootstrap = JSON.stringify({
              deployId,
              deployUrl: record.url,
              publicHost,
              controlUrl: apiUrl,
              lastBuild,
            })
            const html = ideHtml.replace("__POND_IDE__BOOTSTRAP__", `window.__POND_IDE = ${bootstrap}`)
            return c.html(html)
          }
        }
        return c.json({ error: "Not found" }, 404)
      }

      const deployId = deployIdFromHost(c.req.header("host"))
      if (!deployId) return c.json({ error: "Not found" }, 404)
      const entry = runningChildren.get(deployId) ?? (await ensureBooted(deployId))
      if (!entry) return c.json({ error: "Unknown deploy" }, 404)
      const url = new URL(c.req.url)
      const target = `http://127.0.0.1:${entry.port}${url.pathname}${url.search}`
      const headers = new Headers()
      c.req.raw.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v)
      })
      const method = c.req.method
      const hasBody = method !== "GET" && method !== "HEAD"
      const init: RequestInit & { duplex?: "half" } = { method, headers }
      if (hasBody) {
        init.body = c.req.raw.body
        init.duplex = "half"
      }
      let upstream: Response
      try {
        upstream = await fetch(target, init)
      } catch (err: any) {
        return c.json({ error: `Upstream error: ${err?.message ?? err}` }, 502)
      }
      const respHeaders = new Headers()
      upstream.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k.toLowerCase())) respHeaders.set(k, v)
      })
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
    })

    const controlServer = serve({ fetch: app.fetch, port, hostname })

    // ── WebSocket upgrade proxy ─────────────────────────────────────────
    // The bare control plane bypasses Hono for HTTP Upgrade requests and pipes
    // them raw to the matching deploy's local port. This lets capsules expose
    // socket() handlers at /api/socket/<name> and have wscat / browser clients
    // reach them through <deployId>.pond.run just like a regular request.
    controlServer.on("upgrade", (req, clientSocket, head) => {
      const hostHeader = (req.headers.host ?? "").toString()
      const deployId = deployIdFromHost(hostHeader)
      if (!deployId) {
        clientSocket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
        clientSocket.destroy()
        return
      }
      const entry = runningChildren.get(deployId)
      if (!entry) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
        clientSocket.destroy()
        return
      }
      // Open a TCP connection to the deploy worker, re-serialize the original
      // upgrade request (parsed headers + any head bytes already buffered),
      // then full-duplex pipe both directions until either end closes.
      const upstream = net.connect({ host: "127.0.0.1", port: entry.port })
      upstream.once("connect", () => {
        const lines: string[] = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
        for (const [name, value] of Object.entries(req.headers)) {
          if (value == null) continue
          if (Array.isArray(value)) {
            for (const v of value) lines.push(`${name}: ${v}`)
          } else {
            lines.push(`${name}: ${value}`)
          }
        }
        lines.push("", "")
        upstream.write(lines.join("\r\n"))
        if (head && head.length > 0) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      const destroyBoth = () => {
        try {
          upstream.destroy()
        } catch {
          // best effort
        }
        try {
          clientSocket.destroy()
        } catch {
          // best effort
        }
      }
      upstream.on("error", destroyBoth)
      clientSocket.on("error", destroyBoth)
      clientSocket.on("close", () => upstream.destroy())
      upstream.on("close", () => clientSocket.destroy())
    })

    const shutdown = async () => {
      shuttingDown = true
      console.log("\n[pond host] shutting down")
      for (const deployId of [...runningChildren.keys()]) {
        await stopDeploy(deployId)
      }
      controlDb.close()
      controlServer.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 2000).unref()
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)

    console.log(`\n  pond host control plane running at http://${hostname}:${port}`)
    if (publicBaseUrl) {
      console.log(`  public base URL: ${publicBaseUrl.toString().replace(/\/$/, "")}`)
    }
    if (!abuseEmail) {
      console.log(`  ⚠ no --abuse-email set — security.txt / abuse page will be unhelpful for a public deploy.`)
    }
    if (hostTokenGenerated) {
      // First run only: surface the freshly generated token once so the operator
      // can capture it. On subsequent boots we never reprint it — stdout lands in
      // `docker logs`, and the value is persisted to the 0600 token file anyway.
      console.log(`  host token (bootstrap / recovery, generated now): ${hostToken}`)
      console.log(`  ^ save this — it will NOT be printed again. Also stored at ${tokenFile}.`)
    } else {
      console.log(
        `  host token: configured (from ${process.env.POND_HOST_TOKEN ? "POND_HOST_TOKEN" : tokenFile}) — not printed`,
      )
    }
    console.log(`  bootstrap first admin: pond login --api ${apiUrl} --username <name>`)
    if (anonymousEnabled) {
      console.log(
        `  anonymous deploys: enabled (grace=${formatHumanDuration(anonymousGraceMs)}, retention=${formatHumanDuration(anonymousRetentionMs)}, rate=${anonymousRateLimit}/h)\n`,
      )
    } else {
      console.log("  anonymous deploys: disabled\n")
    }
    if (anonymousEnabled) {
      console.log(
        turnstileSecret
          ? `  anonymous deploy challenge: Cloudflare Turnstile enabled (from ${process.env.POND_TURNSTILE_SECRET ? "POND_TURNSTILE_SECRET" : "--turnstile-secret"})`
          : "  anonymous deploy challenge: none (set --turnstile-secret / POND_TURNSTILE_SECRET to require Turnstile)",
      )
    }
    if (capsuleCgroupRoot) {
      console.log(`  capsule isolation: cgroup v2 enabled at ${capsuleCgroupRoot} (per-capsule cpu/memory/pids caps)`)
      console.log(`  capsule egress policy: ${egressMode}`)
    } else {
      console.log("  capsule isolation: cgroup limits OFF (heap cap only) — set --capsule-cgroup-root to enable")
      // The OS egress firewall (deploy/capsule-egress.nft) matches on capsule
      // cgroup membership. With no cgroup root, no capsule socket carries the
      // `pond` cgroup tag, so a loaded nft ruleset matches NOTHING — capsules
      // have unrestricted OS-level egress even though `nft -f` succeeded. Warn
      // loudly so an operator doesn't get a false sense of security. (In
      // 'sealed' mode the JS-layer block still applies, but it is bypassable by
      // native addons / DNS — the OS firewall is the real boundary.)
      console.log(
        `  ⚠ capsule egress policy '${egressMode}': the nft egress firewall keys on cgroup membership, ` +
          `so with cgroup isolation OFF any loaded capsule-egress.nft rules match NOTHING (no OS-level egress ` +
          `enforcement). Run deploy/setup-capsule-isolation.sh and set --capsule-cgroup-root. See deploy/HARDENING.md.`,
      )
    }
    if (hostname === "0.0.0.0" || hostname === "::") {
      console.log(
        "  ⚠ bound to all interfaces — deploying a bundle here gives the caller arbitrary code execution as this user.\n",
      )
    }
  },
})
