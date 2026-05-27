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
    <div class="flex min-h-screen items-center justify-center bg-black text-zinc-200">
      <form
        class="w-full max-w-md space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (t.trim()) onSubmit(t.trim())
        }}
      >
        <h1 class="text-xl font-semibold">pond dashboard</h1>
        <p class="text-sm text-zinc-400">
          Paste your account API token. <code>pond login --api ...</code> writes it to{" "}
          <code>~/.pond/credentials.json</code>.
        </p>
        {error ? <div class="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">{error}</div> : null}
        <input
          type="password"
          class="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-sm outline-none focus:border-zinc-600"
          placeholder="bearer token"
          value={t}
          onInput={(e) => setT((e.target as HTMLInputElement).value)}
        />
        <button class="w-full rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-zinc-200">
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

  return (
    <div class="min-h-screen bg-black text-zinc-100">
      <header class="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6 py-3">
        <div>
          <h1 class="text-lg font-semibold leading-tight">pond dashboard</h1>
          <p class="text-xs text-zinc-500">
            {me.username}
            {me.isAdmin ? " · admin" : ""} · {deploys.length} project{deploys.length === 1 ? "" : "s"}
          </p>
        </div>
        <div class="flex gap-2">
          <button
            class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
            onClick={handleRotateUserToken}
          >
            rotate token
          </button>
          <button
            class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
            onClick={onSignOut}
          >
            sign out
          </button>
        </div>
      </header>
      {flash ? (
        <div class="border-b border-emerald-900 bg-emerald-950 px-6 py-2 text-xs text-emerald-300">{flash}</div>
      ) : null}
      {err ? (
        <div class="border-b border-red-900 bg-red-950 px-6 py-2 text-xs text-red-200">
          {err}
          <button class="ml-3 underline" onClick={() => setErr(null)}>
            dismiss
          </button>
        </div>
      ) : null}
      <main class="mx-auto max-w-5xl p-6">
        {loading ? (
          <p class="text-sm text-zinc-500">Loading deploys…</p>
        ) : deploys.length === 0 ? (
          <p class="text-sm text-zinc-500">
            No projects yet. Run <code>pond new my-app && cd my-app && pond deploy</code>.
          </p>
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
      </main>
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
    <article class="rounded-xl border border-zinc-800 bg-zinc-950">
      <header class="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-900 px-5 py-4">
        <div class="min-w-0">
          <h2 class="truncate text-lg font-semibold text-zinc-50">{heading}</h2>
          <p class="mt-1 text-xs text-zinc-500">
            <a
              class="font-mono text-zinc-400 underline decoration-zinc-800 hover:text-zinc-200 hover:decoration-zinc-500"
              href={d.url}
              target="_blank"
              rel="noreferrer"
            >
              {d.url.replace(/^https?:\/\//, "")}
            </a>
            <span class="mx-2 text-zinc-700">·</span>
            <span class="font-mono text-zinc-600">{shortId}</span>
            <span class="mx-2 text-zinc-700">·</span>
            <span>{age}</span>
          </p>
          {d.description ? <p class="mt-2 max-w-2xl text-sm text-zinc-400">{d.description}</p> : null}
        </div>
        <div class="flex flex-shrink-0 items-center gap-2">
          <StatusPill d={d} isOwner={isOwner} />
        </div>
      </header>
      <div class="flex flex-wrap items-center justify-end gap-2 px-5 py-3">
        <a
          class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
          href={d.url}
          target="_blank"
          rel="noreferrer"
        >
          Open live app
        </a>
        <a
          class="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-zinc-200"
          href={ideHref}
        >
          Open IDE →
        </a>
        {isOwner ? (
          <Fragment>
            <button
              class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
              onClick={onRotateClaim}
              title="Rotate claim token (copied to clipboard)"
            >
              Rotate claim
            </button>
            <button
              class="rounded-md border border-red-900 bg-black px-3 py-1.5 text-xs text-red-300 hover:bg-red-950"
              onClick={onDelete}
            >
              Delete
            </button>
          </Fragment>
        ) : null}
      </div>
    </article>
  )
}

function StatusPill({ d, isOwner }: { d: DeployRow; isOwner: boolean }) {
  if (d.anonymous) {
    return (
      <div class="text-right">
        <span class="rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-200">anonymous</span>
        {d.terminatesAt ? (
          <div class="mt-1 text-xs text-zinc-500">terminates {humanAge(d.terminatesAt, true)}</div>
        ) : null}
      </div>
    )
  }
  if (isOwner) {
    return <span class="rounded bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-200">owned</span>
  }
  return <span class="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">shared</span>
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
