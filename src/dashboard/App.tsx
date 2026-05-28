import { Fragment } from "preact"
import { useEffect, useMemo, useState } from "preact/hooks"

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
  const [deploys, setDeploys] = useState<DeployRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)

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
        <section class="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-8">
          <KpiTile label="Total deploys" value={stats.total} accent />
          <KpiTile label="Live" value={stats.live} accent />
          <KpiTile label="Anonymous" value={stats.anon} accent={stats.anon > 0} muted={stats.anon === 0} />
          <KpiTile label="Owned by you" value={stats.mine} accent />
        </section>

        <section>
          <div class="mb-3 flex items-end justify-between">
            <h2 class="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Your projects</h2>
            {!loading && deploys.length > 0 ? (
              <p class="text-xs text-zinc-600">
                {deploys.length} {deploys.length === 1 ? "result" : "results"}
              </p>
            ) : null}
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
      {accent && !muted ? (
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
            <h2 class="truncate text-base font-semibold text-zinc-50">{heading}</h2>
            <StatusPill d={d} isOwner={isOwner} />
          </div>
          <p class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
            <a class="font-mono text-zinc-400 hover:text-emerald-300" href={d.url} target="_blank" rel="noreferrer">
              {d.url.replace(/^https?:\/\//, "")}
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
            href={d.url}
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
