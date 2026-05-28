import { Fragment, type VNode } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"

declare global {
  interface Window {
    __POND_DASHBOARD?: { controlUrl: string; publicHost: string }
  }
}

interface Bootstrap {
  controlUrl: string
  publicHost: string
}

function readBootstrap(): Bootstrap {
  if (typeof window !== "undefined" && window.__POND_DASHBOARD) {
    return {
      controlUrl: window.__POND_DASHBOARD.controlUrl,
      publicHost: window.__POND_DASHBOARD.publicHost,
    }
  }
  return { controlUrl: "", publicHost: "" }
}

const TOKEN_KEY = "pond-dashboard-token"

function loadToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
function storeToken(t: string) {
  try {
    window.localStorage.setItem(TOKEN_KEY, t)
  } catch {}
}
function clearToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

const VIEW_KEY = "pond-dashboard-view"
type ProjectView = "grid" | "list"
function loadView(): ProjectView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"
  } catch {
    return "grid"
  }
}
function storeView(v: ProjectView) {
  try {
    window.localStorage.setItem(VIEW_KEY, v)
  } catch {}
}

interface Me {
  id: string
  username: string
  isAdmin: boolean
}

interface DeployRow {
  deployId: string
  url: string
  apiUrl: string
  createdAt: string
  updatedAt: string
  claimedAt?: string
  ownerId?: string | null
  anonymous: boolean
  terminatesAt?: string
  expiresAt?: string
  terminated?: boolean
  title?: string
  description?: string
  isPublic?: boolean
  publicInspect?: boolean
  // Custom subdomains added via `pond domains add`. First entry is the
  // preferred display URL; the hash `url` is shown as secondary.
  domains?: string[]
}

function primaryUrl(d: DeployRow): string {
  return d.domains && d.domains.length > 0 ? d.domains[0] : d.url
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function fetchMe(token: string): Promise<{ me: Me } | { error: string; status: number }> {
  const r = await fetch("/api/users/me", { headers: authHeaders(token) })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "auth failed", status: r.status }
  return { me: await r.json() }
}

async function fetchDeploys(token: string): Promise<{ deploys: DeployRow[] } | { error: string }> {
  const r = await fetch("/api/deploys", { headers: authHeaders(token) })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "list failed" }
  return r.json()
}

async function rotateClaim(token: string, deployId: string): Promise<{ claimToken: string } | { error: string }> {
  const r = await fetch(`/api/deploys/${deployId}/rotate-claim-token`, {
    method: "POST",
    headers: authHeaders(token),
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "rotate failed" }
  return r.json()
}

async function rotateUserToken(token: string): Promise<{ token: string } | { error: string }> {
  const r = await fetch("/api/users/me/rotate-token", {
    method: "POST",
    headers: authHeaders(token),
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "rotate failed" }
  return r.json()
}

async function deleteDeploy(token: string, deployId: string): Promise<boolean> {
  const r = await fetch(`/api/deploys/${deployId}`, { method: "DELETE", headers: authHeaders(token) })
  return r.ok
}

interface InspectData {
  deployId: string
  dbBytes: number
  dbOpenError?: string
  tableCount: number
  totalRows: number
  tables: Array<{ name: string; rowCount: number; columns: number }>
  sourceFileCount: number
}

async function fetchInspect(token: string, deployId: string): Promise<InspectData | { error: string }> {
  const r = await fetch(`/api/deploys/${deployId}/inspect`, { headers: authHeaders(token) })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "inspect failed" }
  return r.json()
}

interface LogEntry {
  ts?: string
  level?: string
  message?: string
  [k: string]: unknown
}

async function fetchLogs(token: string, deployId: string): Promise<{ entries: LogEntry[] } | { error: string }> {
  const r = await fetch(`/api/deploys/${deployId}/logs?limit=200`, { headers: authHeaders(token) })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "logs failed" }
  return r.json()
}

async function fetchEnv(
  token: string,
  deployId: string,
): Promise<{ entries: Record<string, string> } | { error: string }> {
  const r = await fetch(`/api/deploys/${deployId}/env`, { headers: authHeaders(token) })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "env load failed" }
  return r.json()
}

async function saveEnv(
  token: string,
  deployId: string,
  partial: Record<string, string>,
): Promise<{ entries: Record<string, string> } | { error: string }> {
  const r = await fetch(`/api/deploys/${deployId}/env`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ entries: partial }),
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "save failed" }
  return r.json()
}

async function deleteEnvKey(
  token: string,
  deployId: string,
  key: string,
): Promise<{ entries: Record<string, string> } | { error: string }> {
  const r = await fetch(`/api/deploys/${deployId}/env/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "delete failed" }
  return r.json()
}

async function setVisibility(
  token: string,
  deployId: string,
  publicInspect: boolean,
): Promise<{ publicInspect: boolean } | { error: string }> {
  const r = await fetch(`/api/deploys/${deployId}/visibility`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ publicInspect }),
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "visibility update failed" }
  return r.json()
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface TableSample {
  name: string
  columns: Array<{ name: string; type: string }>
  rows: Array<Record<string, unknown>>
  rowCount: number
  orderBy: string
}

async function fetchTableSample(
  token: string,
  deployId: string,
  table: string,
  limit = 10,
): Promise<TableSample | { error: string }> {
  const r = await fetch(`/api/deploys/${deployId}/inspect/table/${encodeURIComponent(table)}?limit=${limit}`, {
    headers: authHeaders(token),
  })
  if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? "table sample failed" }
  return r.json()
}

function parseHashRoute(hash: string): { deployId: string | null } {
  const m = hash.match(/^#d\/([a-f0-9]+)/i)
  return { deployId: m ? m[1] : null }
}

function useHashRoute() {
  const [route, setRoute] = useState(() =>
    typeof window !== "undefined" ? parseHashRoute(window.location.hash) : { deployId: null },
  )
  useEffect(() => {
    const onChange = () => setRoute(parseHashRoute(window.location.hash))
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])
  return route
}

function navigateTo(hash: string) {
  if (typeof window === "undefined") return
  window.location.hash = hash
}

export function App() {
  const bootstrap = useMemo(readBootstrap, [])
  const [token, setToken] = useState<string | null>(() => loadToken())
  const [me, setMe] = useState<Me | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setMe(null)
      return
    }
    let cancelled = false
    void fetchMe(token).then((res) => {
      if (cancelled) return
      if ("error" in res) {
        setAuthError(`${res.error} (${res.status})`)
        if (res.status === 401 || res.status === 403) {
          clearToken()
          setToken(null)
        }
      } else {
        setMe(res.me)
        setAuthError(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [token])

  if (!token || !me)
    return (
      <SignIn
        onSubmit={(t) => {
          storeToken(t)
          setToken(t)
        }}
        error={authError}
      />
    )
  return (
    <Workspace
      me={me}
      token={token}
      bootstrap={bootstrap}
      onSignOut={() => {
        clearToken()
        setToken(null)
        setMe(null)
      }}
    />
  )
}

function SignIn({ onSubmit, error }: { onSubmit: (t: string) => void; error: string | null }) {
  const [t, setT] = useState("")
  return (
    <div class="relative flex min-h-screen items-center justify-center overflow-hidden bg-black text-zinc-200">
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(16,185,129,0.08),transparent_60%)]" />
      <form
        class="relative w-full max-w-md space-y-5 rounded-2xl border border-zinc-900 bg-zinc-950/80 p-7 backdrop-blur"
        onSubmit={(e) => {
          e.preventDefault()
          if (t.trim()) onSubmit(t.trim())
        }}
      >
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-400/80">Pond</p>
          <h1 class="mt-1 text-2xl font-semibold tracking-tight">Dashboard</h1>
        </div>
        <p class="text-sm leading-relaxed text-zinc-400">
          Paste your account API token.{" "}
          <code class="rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-300">pond login --api …</code> writes it to{" "}
          <code class="rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-300">~/.pond/credentials.json</code>.
        </p>
        {error ? (
          <div class="rounded border border-red-900/60 bg-red-950/40 p-2 text-xs text-red-200">{error}</div>
        ) : null}
        <input
          type="password"
          class="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2.5 text-sm outline-none transition focus:border-emerald-700/60 focus:ring-2 focus:ring-emerald-700/20"
          placeholder="bearer token"
          value={t}
          onInput={(e) => setT((e.target as HTMLInputElement).value)}
        />
        <button class="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-white">
          Open dashboard
        </button>
      </form>
    </div>
  )
}

function Workspace({
  me,
  token,
  bootstrap,
  onSignOut,
}: {
  me: Me
  token: string
  bootstrap: Bootstrap
  onSignOut: () => void
}) {
  const route = useHashRoute()
  const [deploys, setDeploys] = useState<DeployRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const [view, setView] = useState<ProjectView>(() => loadView())
  function chooseView(v: ProjectView) {
    setView(v)
    storeView(v)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchDeploys(token).then((res) => {
      if (cancelled) return
      if ("error" in res) setErr(res.error)
      else {
        setDeploys(res.deploys)
        setErr(null)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [token, reloadKey])

  async function handleRotateClaim(d: DeployRow) {
    const res = await rotateClaim(token, d.deployId)
    if ("error" in res) {
      setErr(res.error)
      return
    }
    await navigator.clipboard.writeText(res.claimToken).catch(() => {})
    setFlash(`New claim token copied to clipboard for ${d.deployId.slice(0, 8)}…`)
    setTimeout(() => setFlash(null), 4000)
  }

  async function handleRotateUserToken() {
    if (!confirm("Rotate your account API token? You'll lose access until you save the new one.")) return
    const res = await rotateUserToken(token)
    if ("error" in res) {
      setErr(res.error)
      return
    }
    await navigator.clipboard.writeText(res.token).catch(() => {})
    setFlash("New API token copied. The old one stays valid for 5 minutes.")
    storeToken(res.token)
    setTimeout(() => setFlash(null), 6000)
  }

  async function handleDelete(d: DeployRow) {
    if (!confirm(`Delete deploy ${d.deployId}? This is irreversible.`)) return
    const ok = await deleteDeploy(token, d.deployId)
    if (!ok) {
      setErr("delete failed")
      return
    }
    setReloadKey((k) => k + 1)
  }

  const stats = useMemo(() => {
    const live = deploys.filter((d) => !d.terminated && !d.anonymous).length
    const anon = deploys.filter((d) => d.anonymous && !d.terminated).length
    const mine = deploys.filter((d) => d.ownerId === me.id).length
    return { total: deploys.length, live, anon, mine }
  }, [deploys, me.id])

  const activeDeploy = useMemo(
    () => (route.deployId ? (deploys.find((d) => d.deployId.startsWith(route.deployId!)) ?? null) : null),
    [route.deployId, deploys],
  )

  if (route.deployId && !loading) {
    if (activeDeploy) {
      return (
        <DeployDetail
          d={activeDeploy}
          me={me}
          token={token}
          flash={flash}
          err={err}
          onClearErr={() => setErr(null)}
          onBack={() => navigateTo("")}
          onRotateClaim={() => void handleRotateClaim(activeDeploy)}
          onDelete={async () => {
            await handleDelete(activeDeploy)
            navigateTo("")
          }}
          onSignOut={onSignOut}
        />
      )
    }
    // deployId in URL but no matching deploy loaded — fall through to list
  }

  return (
    <div class="min-h-screen bg-black text-zinc-100">
      <header class="border-b border-zinc-900 bg-zinc-950/60 backdrop-blur">
        <div class="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight text-zinc-50">pond Dashboard</h1>
            <p class="mt-1 text-sm text-zinc-500">
              <span class="font-mono text-zinc-400">{me.username}</span>
              {me.isAdmin ? (
                <span class="ml-2 rounded bg-emerald-900/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">
                  admin
                </span>
              ) : null}
              <span class="mx-2 text-zinc-700">·</span>
              {deploys.length} {deploys.length === 1 ? "deploy" : "deploys"}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Refresh
            </button>
            <button
              class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
              onClick={handleRotateUserToken}
            >
              Rotate token
            </button>
            <button
              class="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-white"
              onClick={onSignOut}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      {flash ? (
        <div class="border-b border-emerald-900/60 bg-emerald-950/40 px-6 py-2 text-xs text-emerald-300">{flash}</div>
      ) : null}
      {err ? (
        <div class="border-b border-red-900/60 bg-red-950/40 px-6 py-2 text-xs text-red-200">
          {err}
          <button class="ml-3 underline decoration-red-700 hover:decoration-red-300" onClick={() => setErr(null)}>
            dismiss
          </button>
        </div>
      ) : null}
      <main class="mx-auto max-w-7xl px-6 py-8">
        <section class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile label="Total deploys" value={stats.total} accent />
          <KpiTile label="Live" value={stats.live} accent />
          <KpiTile label="Anonymous" value={stats.anon} accent={stats.anon > 0} muted={stats.anon === 0} />
          <KpiTile label="Owned by you" value={stats.mine} accent />
        </section>

        <ActivityChart deploys={deploys} className="mb-8" />

        <section>
          <div class="mb-3 flex items-end justify-between gap-3">
            <h2 class="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Your projects</h2>
            <div class="flex items-center gap-3">
              {!loading && deploys.length > 0 ? (
                <p class="text-xs text-zinc-600">
                  {deploys.length} {deploys.length === 1 ? "result" : "results"}
                </p>
              ) : null}
              <ViewToggle view={view} onChange={chooseView} />
            </div>
          </div>
          {loading ? (
            <div class="rounded-xl border border-zinc-900 bg-zinc-950 px-5 py-12 text-center text-sm text-zinc-500">
              Loading deploys…
            </div>
          ) : deploys.length === 0 ? (
            <div class="rounded-xl border border-zinc-900 bg-zinc-950 px-5 py-12 text-center">
              <p class="text-sm text-zinc-400">No projects yet.</p>
              <p class="mt-2 text-xs text-zinc-600">
                Run{" "}
                <code class="rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-300">
                  pond new my-app && cd my-app && pond deploy
                </code>
              </p>
            </div>
          ) : view === "grid" ? (
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {deploys.map((d) => (
                <DeployGridCard
                  key={d.deployId}
                  d={d}
                  me={me}
                  token={token}
                  onRotateClaim={() => void handleRotateClaim(d)}
                  onDelete={() => void handleDelete(d)}
                />
              ))}
            </div>
          ) : (
            <div class="space-y-3">
              {deploys.map((d) => (
                <DeployCard
                  key={d.deployId}
                  d={d}
                  me={me}
                  token={token}
                  onRotateClaim={() => void handleRotateClaim(d)}
                  onDelete={() => void handleDelete(d)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function KpiTile({
  label,
  value,
  accent = false,
  muted = false,
}: {
  label: string
  value: number
  accent?: boolean
  muted?: boolean
}) {
  return (
    <div
      class={`relative overflow-hidden rounded-xl border ${muted ? "border-zinc-900" : accent ? "border-emerald-900/60" : "border-zinc-800"} bg-zinc-950 px-5 py-4`}
    >
      <p class="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">{label}</p>
      <p class={`mt-2 font-mono text-3xl font-semibold tabular-nums ${muted ? "text-zinc-600" : "text-zinc-50"}`}>
        {value}
      </p>
    </div>
  )
}

function ViewToggle({ view, onChange }: { view: ProjectView; onChange: (v: ProjectView) => void }) {
  const btn = (v: ProjectView, label: string, icon: VNode) => (
    <button
      type="button"
      aria-pressed={view === v}
      title={`${label} view`}
      onClick={() => onChange(v)}
      class={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition ${
        view === v ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {icon}
      <span class="hidden sm:inline">{label}</span>
    </button>
  )
  const gridIcon = (
    <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  )
  const listIcon = (
    <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
      <rect x="1" y="2" width="14" height="2.5" rx="1" />
      <rect x="1" y="6.75" width="14" height="2.5" rx="1" />
      <rect x="1" y="11.5" width="14" height="2.5" rx="1" />
    </svg>
  )
  return (
    <div class="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
      {btn("grid", "Grid", gridIcon)}
      {btn("list", "List", listIcon)}
    </div>
  )
}

function DeployCard({
  d,
  me,
  token,
  onRotateClaim,
  onDelete,
}: {
  d: DeployRow
  me: Me
  token: string
  onRotateClaim: () => void
  onDelete: () => void
}) {
  const isOwner = d.ownerId === me.id
  const age = humanAge(d.createdAt)
  const ideHref = `/ide/${d.deployId}#bearer=${encodeURIComponent(token)}`
  const heading = d.title?.trim() || "Untitled project"
  const shortId = d.deployId.slice(0, 8)
  return (
    <article class="group relative overflow-hidden rounded-xl border border-zinc-900 bg-zinc-950 transition hover:border-zinc-700">
      <div class="absolute left-0 top-0 h-full w-1 bg-emerald-500/0 transition group-hover:bg-emerald-500/60" />
      <div class="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <a
              href={`#d/${d.deployId}`}
              class="truncate text-base font-semibold text-zinc-50 transition hover:text-emerald-300"
            >
              {heading}
            </a>
            <StatusPill d={d} isOwner={isOwner} />
          </div>
          <p class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
            <a
              class="font-mono text-zinc-400 hover:text-emerald-300"
              href={primaryUrl(d)}
              target="_blank"
              rel="noreferrer"
            >
              {primaryUrl(d).replace(/^https?:\/\//, "")}
            </a>
            <span class="text-zinc-800">·</span>
            <span class="font-mono text-zinc-600">{shortId}</span>
            <span class="text-zinc-800">·</span>
            <span>{age}</span>
          </p>
          {d.description ? <p class="mt-2 max-w-2xl text-sm text-zinc-400">{d.description}</p> : null}
        </div>
        <div class="flex flex-shrink-0 flex-wrap items-center gap-2">
          <a
            class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
            href={primaryUrl(d)}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
          <a
            class="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-white"
            href={ideHref}
          >
            IDE →
          </a>
          {isOwner ? (
            <Fragment>
              <button
                class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
                onClick={onRotateClaim}
                title="Rotate claim token (copied to clipboard)"
              >
                Rotate
              </button>
              <button
                class="rounded-md border border-red-900/60 bg-black px-3 py-1.5 text-xs text-red-300 transition hover:border-red-700 hover:bg-red-950/40"
                onClick={onDelete}
              >
                Delete
              </button>
            </Fragment>
          ) : null}
        </div>
      </div>
    </article>
  )
}

// Day-by-day app-creation activity over the trailing window, bucketed from each
// deploy's createdAt. Pure client-side — no extra API call.
function ActivityChart({ deploys, className = "" }: { deploys: DeployRow[]; className?: string }) {
  const DAYS = 30
  const { bars, max, total, firstLabel, midLabel } = useMemo(() => {
    const now = new Date()
    const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS - 1)).getTime()
    const counts = new Array<number>(DAYS).fill(0)
    for (const d of deploys) {
      const t = Date.parse(d.createdAt)
      if (Number.isNaN(t)) continue
      const dt = new Date(t)
      const dayMs = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime()
      const idx = Math.round((dayMs - startMs) / 86_400_000)
      if (idx >= 0 && idx < DAYS) counts[idx]++
    }
    const bars = counts.map((c, i) => ({ c, date: new Date(startMs + i * 86_400_000) }))
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    return {
      bars,
      max: Math.max(1, ...counts),
      total: counts.reduce((a, b) => a + b, 0),
      firstLabel: fmt(bars[0].date),
      midLabel: fmt(bars[Math.floor(DAYS / 2)].date),
    }
  }, [deploys])

  return (
    <section class={`rounded-xl border border-zinc-900 bg-zinc-950 px-5 py-4 ${className}`}>
      <div class="mb-3 flex items-baseline justify-between gap-3">
        <h2 class="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Activity</h2>
        <p class="text-xs text-zinc-600">
          <span class="font-mono text-zinc-300">{total}</span> {total === 1 ? "app" : "apps"} created · last {DAYS} days
        </p>
      </div>
      <div class="flex h-28 items-end gap-[3px]">
        {bars.map((b, i) => {
          const h = b.c === 0 ? 2 : Math.max(6, Math.round((b.c / max) * 100))
          const label = `${b.date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}: ${b.c} ${b.c === 1 ? "app" : "apps"}`
          return (
            <div
              key={i}
              title={label}
              class={`flex-1 rounded-sm transition ${
                b.c > 0 ? "bg-emerald-500/55 hover:bg-emerald-400" : "bg-zinc-800/70 hover:bg-zinc-700"
              }`}
              style={`height:${h}%`}
            />
          )
        })}
      </div>
      <div class="mt-2 flex justify-between text-[10px] text-zinc-600">
        <span>{firstLabel}</span>
        <span>{midLabel}</span>
        <span>Today</span>
      </div>
    </section>
  )
}

// Lazy, scaled live preview of a deploy's page. The iframe src is only set once
// the card scrolls near the viewport (avoids loading every deploy at once); a
// fallback tile shows underneath for apps that refuse framing or haven't loaded.
function LiveThumb({ url, title, fallback }: { url: string; title: string; fallback: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [inView, setInView] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (inView) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === "undefined") {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true)
          io.disconnect()
        }
      },
      { rootMargin: "300px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView])
  return (
    <div ref={ref} class="relative h-40 w-full overflow-hidden border-b border-zinc-900 bg-zinc-900">
      <div class="absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_50%_35%,rgba(16,185,129,0.07),transparent_70%)]">
        <span class="max-w-[80%] truncate px-2 font-mono text-[11px] text-zinc-700">{fallback}</span>
      </div>
      {inView ? (
        <iframe
          src={url}
          title={title}
          loading="lazy"
          tabIndex={-1}
          aria-hidden="true"
          sandbox="allow-scripts allow-same-origin"
          referrerpolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          class={`pointer-events-none absolute left-0 top-0 origin-top-left transition-opacity duration-500 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
          style="width:1000px;height:625px;transform:scale(0.4);border:0;background:#fff"
        />
      ) : null}
      <span class="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-zinc-300 opacity-0 backdrop-blur transition group-hover:opacity-100">
        live
      </span>
      <div class="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/5" />
    </div>
  )
}

function DeployGridCard({
  d,
  me,
  token,
  onRotateClaim,
  onDelete,
}: {
  d: DeployRow
  me: Me
  token: string
  onRotateClaim: () => void
  onDelete: () => void
}) {
  const isOwner = d.ownerId === me.id
  const heading = d.title?.trim() || "Untitled project"
  const url = primaryUrl(d)
  const display = url.replace(/^https?:\/\//, "")
  const ideHref = `/ide/${d.deployId}#bearer=${encodeURIComponent(token)}`
  return (
    <article class="group flex flex-col overflow-hidden rounded-xl border border-zinc-900 bg-zinc-950 transition hover:border-zinc-700">
      <a href={url} target="_blank" rel="noreferrer" class="block">
        <LiveThumb url={url} title={heading} fallback={display} />
      </a>
      <div class="flex min-w-0 flex-1 flex-col gap-3 px-4 py-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <a
              href={`#d/${d.deployId}`}
              class="truncate text-sm font-semibold text-zinc-50 transition hover:text-emerald-300"
            >
              {heading}
            </a>
            <StatusPill d={d} isOwner={isOwner} />
          </div>
          <a
            class="mt-1 block truncate font-mono text-xs text-zinc-500 hover:text-emerald-300"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {display}
          </a>
          <p class="mt-0.5 text-[11px] text-zinc-600">{humanAge(d.createdAt)}</p>
        </div>
        <div class="mt-auto flex flex-wrap items-center gap-1.5">
          <a
            class="rounded-md border border-zinc-800 bg-black px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
          <a
            class="rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-950 transition hover:bg-white"
            href={ideHref}
          >
            IDE →
          </a>
          {isOwner ? (
            <Fragment>
              <button
                class="rounded-md border border-zinc-800 bg-black px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
                onClick={onRotateClaim}
                title="Rotate claim token (copied to clipboard)"
              >
                Rotate
              </button>
              <button
                class="rounded-md border border-red-900/60 bg-black px-2.5 py-1 text-xs text-red-300 transition hover:border-red-700 hover:bg-red-950/40"
                onClick={onDelete}
              >
                Delete
              </button>
            </Fragment>
          ) : null}
        </div>
      </div>
    </article>
  )
}

function StatusPill({ d, isOwner }: { d: DeployRow; isOwner: boolean }) {
  if (d.anonymous) {
    return (
      <span
        class="inline-flex items-center gap-1.5 rounded-full border border-amber-900/60 bg-amber-950/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-200"
        title={d.terminatesAt ? `terminates ${humanAge(d.terminatesAt, true)}` : undefined}
      >
        <span class="h-1.5 w-1.5 rounded-full bg-amber-400" />
        anonymous
      </span>
    )
  }
  if (isOwner) {
    return (
      <span class="inline-flex items-center gap-1.5 rounded-full border border-emerald-900/60 bg-emerald-950/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-200">
        <span class="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        live
      </span>
    )
  }
  return (
    <span class="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-400">
      <span class="h-1.5 w-1.5 rounded-full bg-zinc-500" />
      shared
    </span>
  )
}

type DetailTab = "overview" | "tables" | "logs" | "settings"

function DeployDetail({
  d,
  me,
  token,
  flash,
  err,
  onClearErr,
  onBack,
  onRotateClaim,
  onDelete,
  onSignOut,
}: {
  d: DeployRow
  me: Me
  token: string
  flash: string | null
  err: string | null
  onClearErr: () => void
  onBack: () => void
  onRotateClaim: () => void
  onDelete: () => void
  onSignOut: () => void
}) {
  const [tab, setTab] = useState<DetailTab>("overview")
  const [inspect, setInspect] = useState<InspectData | null>(null)
  const [inspectErr, setInspectErr] = useState<string | null>(null)
  const [inspectLoading, setInspectLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setInspectLoading(true)
    void fetchInspect(token, d.deployId).then((res) => {
      if (cancelled) return
      if ("error" in res) {
        setInspectErr(res.error)
        setInspect(null)
      } else {
        setInspect(res)
        setInspectErr(null)
      }
      setInspectLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [token, d.deployId, refreshKey])

  const isOwner = d.ownerId === me.id
  const heading = d.title?.trim() || "Untitled project"
  const ideHref = `/ide/${d.deployId}#bearer=${encodeURIComponent(token)}`
  const liveTag = d.terminated ? "Terminated" : d.anonymous ? "Anonymous" : "Live"
  const liveTagColor = d.terminated ? "text-zinc-500" : d.anonymous ? "text-amber-300" : "text-emerald-300"

  return (
    <div class="min-h-screen bg-black text-zinc-100">
      <header class="border-b border-zinc-900 bg-zinc-950/60 backdrop-blur">
        <div class="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-4 px-6 py-5">
          <div class="min-w-0">
            <button
              class="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500 transition hover:text-zinc-300"
              onClick={onBack}
            >
              ← Dashboard
            </button>
            <h1 class="truncate text-2xl font-semibold tracking-tight text-zinc-50">{heading}</h1>
            <p class="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-zinc-500">
              <a
                class="font-mono text-zinc-400 hover:text-emerald-300"
                href={primaryUrl(d)}
                target="_blank"
                rel="noreferrer"
              >
                {primaryUrl(d).replace(/^https?:\/\//, "")}
              </a>
              <span class="text-zinc-800">·</span>
              <span class="font-mono text-zinc-600">{d.deployId.slice(0, 12)}</span>
              <span class="text-zinc-800">·</span>
              <span class={`font-medium ${liveTagColor}`}>{liveTag}</span>
            </p>
            {d.domains && d.domains.length > 0 && primaryUrl(d) !== d.url ? (
              <p class="mt-1 text-xs text-zinc-600">
                also at{" "}
                <a class="font-mono hover:text-zinc-400" href={d.url} target="_blank" rel="noreferrer">
                  {d.url.replace(/^https?:\/\//, "")}
                </a>
                {d.domains.length > 1
                  ? d.domains.slice(1).map((u) => (
                      <>
                        ,{" "}
                        <a class="font-mono hover:text-zinc-400" href={u} target="_blank" rel="noreferrer">
                          {u.replace(/^https?:\/\//, "")}
                        </a>
                      </>
                    ))
                  : null}
              </p>
            ) : null}
          </div>
          <div class="flex items-center gap-2">
            <button
              class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              Refresh
            </button>
            <a
              class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
              href={primaryUrl(d)}
              target="_blank"
              rel="noreferrer"
            >
              Preview
            </a>
            <a
              class="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-white"
              href={ideHref}
            >
              IDE →
            </a>
          </div>
        </div>
      </header>
      {flash ? (
        <div class="border-b border-emerald-900/60 bg-emerald-950/40 px-6 py-2 text-xs text-emerald-300">{flash}</div>
      ) : null}
      {err ? (
        <div class="border-b border-red-900/60 bg-red-950/40 px-6 py-2 text-xs text-red-200">
          {err}
          <button class="ml-3 underline decoration-red-700 hover:decoration-red-300" onClick={onClearErr}>
            dismiss
          </button>
        </div>
      ) : null}
      <div class="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[180px_minmax(0,1fr)_280px]">
        <DetailSidebar tab={tab} onTab={setTab} />
        <main class="min-w-0 space-y-6">
          {tab === "overview" ? (
            <OverviewTab d={d} token={token} inspect={inspect} loading={inspectLoading} error={inspectErr} />
          ) : null}
          {tab === "tables" ? <TablesTab inspect={inspect} loading={inspectLoading} error={inspectErr} /> : null}
          {tab === "logs" ? <LogsTab token={token} deployId={d.deployId} /> : null}
          {tab === "settings" ? (
            <SettingsTab d={d} token={token} isOwner={isOwner} onRotateClaim={onRotateClaim} onDelete={onDelete} />
          ) : null}
        </main>
        <aside class="space-y-4">
          <DiagnosticsCard d={d} inspect={inspect} loading={inspectLoading} />
          <OutlineCard inspect={inspect} loading={inspectLoading} />
          <a
            class="block rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-center text-sm font-semibold text-emerald-200 transition hover:border-emerald-700 hover:bg-emerald-950/60"
            href={primaryUrl(d)}
            target="_blank"
            rel="noreferrer"
          >
            Open Live App ↗
          </a>
        </aside>
      </div>
    </div>
  )
}

function DetailSidebar({ tab, onTab }: { tab: DetailTab; onTab: (t: DetailTab) => void }) {
  const items: Array<{ id: DetailTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "tables", label: "Tables" },
    { id: "logs", label: "Logs" },
    { id: "settings", label: "Settings" },
  ]
  return (
    <nav class="rounded-xl border border-zinc-900 bg-zinc-950 p-2">
      <p class="px-3 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Navigation</p>
      <div class="space-y-0.5">
        {items.map((it) => (
          <button
            key={it.id}
            class={`block w-full rounded-md px-3 py-2 text-left text-sm transition ${
              tab === it.id
                ? "bg-zinc-100 font-semibold text-zinc-950"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            }`}
            onClick={() => onTab(it.id)}
          >
            {it.label}
          </button>
        ))}
      </div>
    </nav>
  )
}

function OverviewTab({
  d,
  token,
  inspect,
  loading,
  error,
}: {
  d: DeployRow
  token: string
  inspect: InspectData | null
  loading: boolean
  error: string | null
}) {
  const dbKb = inspect ? Math.round(inspect.dbBytes / 102.4) / 10 : 0 // KB to 1dp
  const dbDisplay = inspect ? (dbKb >= 1024 ? `${(dbKb / 1024).toFixed(1)} MB` : `${dbKb} KB`) : "—"
  return (
    <>
      <h2 class="text-base font-semibold text-zinc-100">Overview</h2>
      <section class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Tables" value={inspect?.tableCount ?? 0} accent />
        <KpiTile label="Total rows" value={inspect?.totalRows ?? 0} accent />
        <KpiTileText label="DB size" value={loading ? "…" : dbDisplay} accent={!loading && !!inspect} />
        <KpiTile label="Source files" value={inspect?.sourceFileCount ?? 0} accent />
      </section>
      {error ? (
        <div class="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-xs text-red-300">
          Inspect error: {error}
        </div>
      ) : null}
      {inspect?.dbOpenError ? (
        <div class="rounded-lg border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
          Could not open capsule DB: {inspect.dbOpenError}
        </div>
      ) : null}
      {inspect && inspect.tables.length > 0 ? (
        <RecentActivityCard token={token} deployId={d.deployId} tables={inspect.tables} />
      ) : null}
      <section class="rounded-xl border border-zinc-900 bg-zinc-950">
        <header class="border-b border-zinc-900 px-4 py-3">
          <h3 class="text-sm font-semibold text-zinc-100">Deploy meta</h3>
        </header>
        <dl class="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-4 text-xs">
          <Meta label="Deploy ID" value={<span class="font-mono text-zinc-300">{d.deployId}</span>} />
          <Meta label="Created" value={humanAge(d.createdAt)} />
          <Meta label="Updated" value={humanAge(d.updatedAt)} />
          <Meta
            label="Public inspect"
            value={
              d.publicInspect ? (
                <span class="text-emerald-300">enabled</span>
              ) : (
                <span class="text-zinc-500">disabled</span>
              )
            }
          />
          <Meta
            label="In public listing"
            value={
              d.isPublic ? (
                <span class="text-emerald-300">yes (capsule declares public: true)</span>
              ) : (
                <span class="text-zinc-500">no</span>
              )
            }
          />
          {d.terminatesAt ? <Meta label="Terminates" value={humanAge(d.terminatesAt, true)} /> : null}
          {d.expiresAt ? <Meta label="Expires" value={humanAge(d.expiresAt, true)} /> : null}
        </dl>
      </section>
    </>
  )
}

function Meta({ label, value }: { label: string; value: any }) {
  return (
    <>
      <dt class="text-zinc-500">{label}</dt>
      <dd class="text-right text-zinc-300">{value}</dd>
    </>
  )
}

function RecentActivityCard({
  token,
  deployId,
  tables,
}: {
  token: string
  deployId: string
  tables: Array<{ name: string; rowCount: number; columns: number }>
}) {
  // Default to the largest non-empty user table. Falls back to the first
  // table if everything is empty, so we still render the chooser and an
  // explicit empty state instead of hiding the panel.
  const candidates = useMemo(() => tables.filter((t) => t.rowCount > 0), [tables])
  const defaultName = useMemo(() => {
    if (candidates.length > 0) {
      return candidates.slice().sort((a, b) => b.rowCount - a.rowCount)[0].name
    }
    return tables[0]?.name ?? null
  }, [candidates, tables])
  const [selected, setSelected] = useState<string | null>(defaultName)
  const [sample, setSample] = useState<TableSample | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // If the inspect refresh changes the largest table, follow it — but only
  // when the user hasn't manually picked. We approximate "manually picked"
  // by remembering whether the current selection still matches the
  // most-recent default. This avoids overriding user intent.
  useEffect(() => {
    setSelected((prev) => prev ?? defaultName)
  }, [defaultName])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setLoading(true)
    void fetchTableSample(token, deployId, selected, 10).then((res) => {
      if (cancelled) return
      if ("error" in res) {
        setError(res.error)
        setSample(null)
      } else {
        setSample(res)
        setError(null)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [token, deployId, selected])

  // Columns to display: drop the synthetic __rowid we add server-side and
  // truncate to 5 columns to keep the layout readable; full data still
  // available in the Tables tab.
  const displayCols = useMemo(() => {
    if (!sample) return []
    return sample.columns.filter((c) => c.name !== "__rowid").slice(0, 5)
  }, [sample])

  return (
    <section class="rounded-xl border border-zinc-900 bg-zinc-950">
      <header class="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 px-4 py-3">
        <div>
          <h3 class="text-sm font-semibold text-zinc-100">Recent activity</h3>
          <p class="mt-0.5 text-[11px] text-zinc-500">
            Latest 10 rows
            {sample ? (
              <>
                {" "}
                · ordered by <code class="font-mono text-zinc-400">{sample.orderBy}</code> ·{" "}
                {sample.rowCount.toLocaleString()} total
              </>
            ) : null}
          </p>
        </div>
        {tables.length > 1 ? (
          <select
            class="rounded-md border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-200 outline-none transition focus:border-emerald-700/60"
            value={selected ?? ""}
            onChange={(e) => setSelected((e.target as HTMLSelectElement).value)}
          >
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.rowCount.toLocaleString()})
              </option>
            ))}
          </select>
        ) : null}
      </header>
      {error ? (
        <div class="border-b border-red-900/60 bg-red-950/30 px-4 py-2 text-xs text-red-300">{error}</div>
      ) : null}
      {loading ? (
        <div class="px-4 py-8 text-center text-xs text-zinc-500">Loading rows…</div>
      ) : !sample || sample.rows.length === 0 ? (
        <div class="px-4 py-8 text-center text-xs text-zinc-500">
          No rows in <code class="font-mono text-zinc-400">{selected ?? "?"}</code> yet.
        </div>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="border-b border-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                {displayCols.map((col) => (
                  <th key={col.name} class="px-4 py-2 text-left font-medium">
                    {col.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-900">
              {sample.rows.map((row, idx) => (
                <tr key={idx} class="transition hover:bg-zinc-900/30">
                  {displayCols.map((col) => (
                    <td key={col.name} class="px-4 py-2 align-top font-mono text-zinc-300">
                      <CellValue value={row[col.name]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span class="italic text-zinc-600">null</span>
  }
  if (typeof value === "boolean") {
    return <span class="text-emerald-300">{String(value)}</span>
  }
  if (typeof value === "number") {
    return <span class="tabular-nums text-zinc-200">{value.toLocaleString()}</span>
  }
  if (typeof value === "object") {
    return <span class="text-zinc-500">{JSON.stringify(value)}</span>
  }
  const s = String(value)
  // Heuristic ISO date rendering — server returns timestamps as strings in our
  // capsule schemas. If it parses to a real date and looks date-shaped,
  // render relative age; otherwise truncate to keep rows skim-able.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const ts = Date.parse(s)
    if (!Number.isNaN(ts)) {
      return <span title={s}>{humanAge(s)}</span>
    }
  }
  if (s.length > 80) {
    return <span title={s}>{s.slice(0, 80)}…</span>
  }
  return <>{s}</>
}

function KpiTileText({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      class={`relative overflow-hidden rounded-xl border ${accent ? "border-emerald-900/60" : "border-zinc-800"} bg-zinc-950 px-5 py-4`}
    >
      <p class="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">{label}</p>
      <p class="mt-2 font-mono text-2xl font-semibold tabular-nums text-zinc-50">{value}</p>
      {accent ? (
        <svg
          class="pointer-events-none absolute bottom-0 left-0 h-8 w-12"
          viewBox="0 0 48 32"
          preserveAspectRatio="none"
        >
          <polygon points="0,32 48,32 0,0" fill="rgb(16 185 129 / 0.18)" />
          <polyline points="0,32 48,32" stroke="rgb(16 185 129 / 0.6)" stroke-width="1" fill="none" />
        </svg>
      ) : null}
    </div>
  )
}

function TablesTab({
  inspect,
  loading,
  error,
}: {
  inspect: InspectData | null
  loading: boolean
  error: string | null
}) {
  if (loading) {
    return <p class="text-sm text-zinc-500">Loading tables…</p>
  }
  if (error) {
    return <div class="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-xs text-red-300">{error}</div>
  }
  if (!inspect || inspect.tables.length === 0) {
    return (
      <div class="rounded-xl border border-zinc-900 bg-zinc-950 px-5 py-12 text-center text-sm text-zinc-500">
        No tables in this capsule yet.
      </div>
    )
  }
  return (
    <>
      <h2 class="text-base font-semibold text-zinc-100">Tables</h2>
      <section class="overflow-hidden rounded-xl border border-zinc-900 bg-zinc-950">
        <table class="w-full text-sm">
          <thead class="border-b border-zinc-900 bg-zinc-950 text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th class="px-4 py-3 text-left font-medium">Name</th>
              <th class="px-4 py-3 text-right font-medium">Rows</th>
              <th class="px-4 py-3 text-right font-medium">Columns</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-900">
            {inspect.tables.map((t) => (
              <tr key={t.name} class="transition hover:bg-zinc-900/40">
                <td class="px-4 py-3 font-mono text-zinc-200">{t.name}</td>
                <td class="px-4 py-3 text-right font-mono tabular-nums text-zinc-300">{t.rowCount.toLocaleString()}</td>
                <td class="px-4 py-3 text-right font-mono tabular-nums text-zinc-500">{t.columns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}

function LogsTab({ token, deployId }: { token: string; deployId: string }) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchLogs(token, deployId).then((res) => {
      if (cancelled) return
      if ("error" in res) {
        setError(res.error)
        setEntries([])
      } else {
        setEntries(res.entries.reverse())
        setError(null)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [token, deployId, reloadKey])

  return (
    <>
      <div class="flex items-end justify-between">
        <h2 class="text-base font-semibold text-zinc-100">Logs</h2>
        <button
          class="rounded-md border border-zinc-800 bg-black px-3 py-1 text-xs text-zinc-300 transition hover:border-zinc-600"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          Reload
        </button>
      </div>
      {loading ? (
        <p class="text-sm text-zinc-500">Loading logs…</p>
      ) : error ? (
        <div class="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-xs text-red-300">{error}</div>
      ) : entries.length === 0 ? (
        <div class="rounded-xl border border-zinc-900 bg-zinc-950 px-5 py-12 text-center text-sm text-zinc-500">
          No log entries yet.
        </div>
      ) : (
        <section class="overflow-hidden rounded-xl border border-zinc-900 bg-zinc-950">
          <ul class="divide-y divide-zinc-900 font-mono text-xs">
            {entries.map((e, i) => (
              <li key={i} class="grid grid-cols-[110px_60px_minmax(0,1fr)] gap-3 px-4 py-2">
                <span class="text-zinc-500">{e.ts ? new Date(e.ts).toLocaleTimeString() : ""}</span>
                <span
                  class={`text-xs uppercase ${
                    e.level === "error" ? "text-red-400" : e.level === "warn" ? "text-amber-400" : "text-zinc-500"
                  }`}
                >
                  {e.level ?? "log"}
                </span>
                <span class="truncate text-zinc-300">{e.message ?? JSON.stringify(e)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function SettingsTab({
  d,
  token,
  isOwner,
  onRotateClaim,
  onDelete,
}: {
  d: DeployRow
  token: string
  isOwner: boolean
  onRotateClaim: () => void
  onDelete: () => void
}) {
  return (
    <>
      <h2 class="text-base font-semibold text-zinc-100">Settings</h2>
      <section class="space-y-4">
        <VisibilityToggle token={token} deployId={d.deployId} initial={Boolean(d.publicInspect)} disabled={!isOwner} />
        <EnvEditor token={token} deployId={d.deployId} disabled={!isOwner} />
        <div class="rounded-xl border border-zinc-900 bg-zinc-950 p-5">
          <h3 class="text-sm font-semibold text-zinc-100">Claim token</h3>
          <p class="mt-1 text-xs text-zinc-500">
            The claim token authorizes CLI redeploys for this capsule. Rotate it if it may have been leaked — the new
            token is copied to your clipboard.
          </p>
          <button
            class="mt-3 rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-50"
            onClick={onRotateClaim}
            disabled={!isOwner}
          >
            Rotate claim token
          </button>
        </div>
        <div class="rounded-xl border border-red-900/60 bg-red-950/10 p-5">
          <h3 class="text-sm font-semibold text-red-200">Delete deploy</h3>
          <p class="mt-1 text-xs text-red-300/70">
            Permanently removes the capsule, its database, and all associated source files. This cannot be undone.
          </p>
          <button
            class="mt-3 rounded-md border border-red-900/60 bg-black px-3 py-1.5 text-xs text-red-300 transition hover:border-red-700 hover:bg-red-950/40 disabled:opacity-50"
            onClick={onDelete}
            disabled={!isOwner}
          >
            Delete this deploy
          </button>
        </div>
      </section>
    </>
  )
}

function VisibilityToggle({
  token,
  deployId,
  initial,
  disabled,
}: {
  token: string
  deployId: string
  initial: boolean
  disabled: boolean
}) {
  const [enabled, setEnabled] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle(next: boolean) {
    if (busy || disabled) return
    setBusy(true)
    setError(null)
    const prev = enabled
    setEnabled(next) // optimistic
    const res = await setVisibility(token, deployId, next)
    setBusy(false)
    if ("error" in res) {
      setError(res.error)
      setEnabled(prev) // revert
      return
    }
    setEnabled(res.publicInspect)
  }

  return (
    <div class="rounded-xl border border-zinc-900 bg-zinc-950 p-5">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="text-sm font-semibold text-zinc-100">Public inspect</h3>
          <p class="mt-1 text-xs text-zinc-500">
            When <span class="text-zinc-300">enabled</span>, anyone can read the capsule's schema and database tables
            via <code class="rounded bg-zinc-900 px-1 py-0.5">/__pond/inspect</code> — no claim token needed. Disabled
            by default; flip on for explicitly shared demos.
          </p>
          <p class="mt-1 text-xs text-zinc-600">Saving toggles the worker; ~2s redeploy.</p>
        </div>
        <button
          class={`relative h-6 w-11 flex-shrink-0 rounded-full border transition disabled:opacity-50 ${
            enabled ? "border-emerald-700/60 bg-emerald-600/40" : "border-zinc-800 bg-zinc-900"
          }`}
          onClick={() => void toggle(!enabled)}
          disabled={busy || disabled}
          aria-pressed={enabled}
          aria-label="Toggle public inspect"
        >
          <span
            class={`absolute top-0.5 h-4 w-4 rounded-full bg-zinc-100 shadow transition ${
              enabled ? "translate-x-6" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      {busy ? <p class="mt-3 text-xs text-zinc-500">Redeploying capsule…</p> : null}
      {error ? (
        <div class="mt-3 rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</div>
      ) : null}
    </div>
  )
}

function EnvEditor({ token, deployId, disabled }: { token: string; deployId: string; disabled: boolean }) {
  const [entries, setEntries] = useState<Record<string, string> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState("")
  const [newValue, setNewValue] = useState("")
  const [busy, setBusy] = useState<string | null>(null) // key currently saving/deleting, or "add" or "reload"

  async function reload() {
    setLoading(true)
    const res = await fetchEnv(token, deployId)
    if ("error" in res) {
      setError(res.error)
      setEntries({})
    } else {
      setEntries(res.entries)
      setError(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, deployId])

  function toggleReveal(key: string) {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function startEdit(key: string, value: string) {
    setEditingKey(key)
    setEditValue(value)
    setRevealed((prev) => new Set(prev).add(key))
  }

  function cancelEdit() {
    setEditingKey(null)
    setEditValue("")
  }

  async function commitEdit(key: string) {
    setBusy(key)
    setError(null)
    const res = await saveEnv(token, deployId, { [key]: editValue })
    setBusy(null)
    if ("error" in res) {
      setError(res.error)
      return
    }
    setEntries(res.entries)
    setEditingKey(null)
    setEditValue("")
  }

  async function commitAdd() {
    if (!ENV_KEY_RE.test(newKey)) {
      setError("Key must match [A-Za-z_][A-Za-z0-9_]* (letters, digits, underscore; must not start with a digit).")
      return
    }
    if (entries && newKey in entries) {
      setError(`Key "${newKey}" already exists — edit it in the list instead.`)
      return
    }
    setBusy("__add__")
    setError(null)
    const res = await saveEnv(token, deployId, { [newKey]: newValue })
    setBusy(null)
    if ("error" in res) {
      setError(res.error)
      return
    }
    setEntries(res.entries)
    setNewKey("")
    setNewValue("")
    setAdding(false)
  }

  async function remove(key: string) {
    if (!confirm(`Delete env var "${key}"? The capsule will redeploy.`)) return
    setBusy(key)
    setError(null)
    const res = await deleteEnvKey(token, deployId, key)
    setBusy(null)
    if ("error" in res) {
      setError(res.error)
      return
    }
    setEntries(res.entries)
    setRevealed((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  const keys = entries ? Object.keys(entries).sort() : []

  return (
    <div class="rounded-xl border border-zinc-900 bg-zinc-950">
      <header class="flex items-center justify-between border-b border-zinc-900 px-5 py-4">
        <div>
          <h3 class="text-sm font-semibold text-zinc-100">Environment variables</h3>
          <p class="mt-1 text-xs text-zinc-500">
            Stored in <code class="rounded bg-zinc-900 px-1 py-0.5">.env.pond.server</code> on the capsule. Saving any
            change triggers a redeploy.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-50"
            onClick={() => void reload()}
            disabled={loading}
          >
            Reload
          </button>
          <button
            class="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-white disabled:opacity-50"
            onClick={() => {
              setAdding(true)
              setError(null)
            }}
            disabled={disabled || adding || loading}
          >
            + Add variable
          </button>
        </div>
      </header>

      {error ? (
        <div class="border-b border-red-900/60 bg-red-950/30 px-5 py-3 text-xs text-red-300">
          {error}
          <button class="ml-3 underline" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      {adding ? (
        <div class="border-b border-zinc-900 bg-black/40 px-5 py-4">
          <div class="grid grid-cols-[200px_minmax(0,1fr)_auto] gap-2">
            <input
              class="rounded-md border border-zinc-800 bg-black px-3 py-2 font-mono text-sm text-zinc-200 outline-none transition focus:border-emerald-700/60 focus:ring-1 focus:ring-emerald-700/30"
              placeholder="KEY_NAME"
              value={newKey}
              onInput={(e) => setNewKey((e.target as HTMLInputElement).value)}
              disabled={busy === "__add__"}
            />
            <input
              class="rounded-md border border-zinc-800 bg-black px-3 py-2 font-mono text-sm text-zinc-200 outline-none transition focus:border-emerald-700/60 focus:ring-1 focus:ring-emerald-700/30"
              placeholder="value"
              value={newValue}
              onInput={(e) => setNewValue((e.target as HTMLInputElement).value)}
              disabled={busy === "__add__"}
            />
            <div class="flex gap-1">
              <button
                class="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                onClick={() => void commitAdd()}
                disabled={!newKey.trim() || busy === "__add__"}
              >
                {busy === "__add__" ? "Saving…" : "Save"}
              </button>
              <button
                class="rounded-md border border-zinc-800 bg-black px-3 py-2 text-xs text-zinc-300 transition hover:border-zinc-600"
                onClick={() => {
                  setAdding(false)
                  setNewKey("")
                  setNewValue("")
                  setError(null)
                }}
                disabled={busy === "__add__"}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div class="px-5 py-8 text-center text-sm text-zinc-500">Loading variables…</div>
      ) : keys.length === 0 ? (
        <div class="px-5 py-8 text-center text-sm text-zinc-500">
          No environment variables yet. Click <span class="text-zinc-300">+ Add variable</span> to create one.
        </div>
      ) : (
        <ul class="divide-y divide-zinc-900">
          {keys.map((k) => {
            const value = entries![k]
            const isEditing = editingKey === k
            const isRevealed = revealed.has(k) || isEditing
            const isBusy = busy === k
            return (
              <li
                key={k}
                class="grid grid-cols-[200px_minmax(0,1fr)_auto] items-center gap-2 px-5 py-2.5 transition hover:bg-zinc-900/30"
              >
                <code class="truncate font-mono text-sm text-zinc-200">{k}</code>
                {isEditing ? (
                  <input
                    class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 font-mono text-sm text-zinc-200 outline-none transition focus:border-emerald-700/60 focus:ring-1 focus:ring-emerald-700/30"
                    value={editValue}
                    onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                    disabled={isBusy}
                  />
                ) : (
                  <code
                    class="cursor-pointer truncate font-mono text-sm text-zinc-400 hover:text-zinc-200"
                    onClick={() => !disabled && startEdit(k, value)}
                    title={disabled ? undefined : "Click to edit"}
                  >
                    {isRevealed
                      ? value || <span class="italic text-zinc-600">(empty)</span>
                      : "•".repeat(Math.min(12, Math.max(4, value.length)))}
                  </code>
                )}
                <div class="flex gap-1">
                  {isEditing ? (
                    <>
                      <button
                        class="rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                        onClick={() => void commitEdit(k)}
                        disabled={isBusy}
                      >
                        {isBusy ? "Saving…" : "Save"}
                      </button>
                      <button
                        class="rounded-md border border-zinc-800 bg-black px-2.5 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600"
                        onClick={cancelEdit}
                        disabled={isBusy}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        class="rounded-md border border-zinc-800 bg-black px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-50"
                        onClick={() => toggleReveal(k)}
                        title={isRevealed ? "Hide value" : "Reveal value"}
                      >
                        {isRevealed ? "Hide" : "Reveal"}
                      </button>
                      <button
                        class="rounded-md border border-zinc-800 bg-black px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-50"
                        onClick={() => startEdit(k, value)}
                        disabled={disabled || isBusy}
                      >
                        Edit
                      </button>
                      <button
                        class="rounded-md border border-red-900/60 bg-black px-2.5 py-1.5 text-xs text-red-300 transition hover:border-red-700 hover:bg-red-950/40 disabled:opacity-50"
                        onClick={() => void remove(k)}
                        disabled={disabled || isBusy}
                      >
                        {isBusy ? "…" : "Delete"}
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function DiagnosticsCard({ d, inspect, loading }: { d: DeployRow; inspect: InspectData | null; loading: boolean }) {
  const healthy = !d.terminated && !inspect?.dbOpenError
  return (
    <div class="rounded-xl border border-zinc-900 bg-zinc-950">
      <p class="border-b border-zinc-900 px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        Diagnostics
      </p>
      <div class="px-4 py-3">
        <div
          class={`rounded-lg border px-3 py-2 text-xs ${
            healthy
              ? "border-emerald-900/60 bg-emerald-950/20 text-emerald-300"
              : "border-red-900/60 bg-red-950/20 text-red-300"
          }`}
        >
          {loading
            ? "Checking deploy health…"
            : healthy
              ? "Dashboard is healthy and live."
              : d.terminated
                ? "Deploy terminated."
                : "Capsule DB not reachable."}
        </div>
      </div>
    </div>
  )
}

function OutlineCard({ inspect, loading }: { inspect: InspectData | null; loading: boolean }) {
  return (
    <div class="rounded-xl border border-zinc-900 bg-zinc-950">
      <p class="border-b border-zinc-900 px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        Outline
      </p>
      <div class="grid grid-cols-2 gap-px bg-zinc-900">
        <OutlineCell label="Tables" value={loading ? "—" : String(inspect?.tableCount ?? 0)} />
        <OutlineCell label="Rows" value={loading ? "—" : (inspect?.totalRows ?? 0).toLocaleString()} />
        <OutlineCell label="Files" value={loading ? "—" : String(inspect?.sourceFileCount ?? 0)} />
        <OutlineCell label="DB KB" value={loading ? "—" : String(Math.round((inspect?.dbBytes ?? 0) / 1024))} />
      </div>
    </div>
  )
}

function OutlineCell({ label, value }: { label: string; value: string }) {
  return (
    <div class="bg-zinc-950 px-4 py-3">
      <p class="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p class="mt-1 font-mono text-lg font-semibold tabular-nums text-zinc-200">{value}</p>
    </div>
  )
}

function humanAge(iso: string, future = false): string {
  const ts = Date.parse(iso)
  if (!ts) return iso
  const delta = future ? ts - Date.now() : Date.now() - ts
  const s = Math.max(0, Math.round(delta / 1000))
  if (s < 60) return future ? `in ${s}s` : `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return future ? `in ${m}m` : `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return future ? `in ${h}h` : `${h}h ago`
  const d = Math.round(h / 24)
  return future ? `in ${d}d` : `${d}d ago`
}
