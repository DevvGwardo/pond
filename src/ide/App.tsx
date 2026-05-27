import { h, Fragment } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"
import {
  fetchFiles,
  fetchFile,
  putFile,
  deleteFile,
  moveFile,
  build,
  fetchEnv,
  putEnv,
  deleteEnvKey,
  streamLogs,
  type FileEntry,
  type BuildResult,
  type LogEntry,
} from "./api.js"
import { CodeMirrorEditor } from "./Editor.js"

declare global {
  interface Window {
    __POND_IDE?: { deployId: string; deployUrl: string; publicHost: string; controlUrl: string }
  }
}

interface Bootstrap {
  deployId: string
  deployUrl: string
  publicHost: string
}

function readBootstrap(): Bootstrap {
  if (typeof window !== "undefined" && window.__POND_IDE) {
    return {
      deployId: window.__POND_IDE.deployId,
      deployUrl: window.__POND_IDE.deployUrl,
      publicHost: window.__POND_IDE.publicHost,
    }
  }
  return { deployId: "", deployUrl: "", publicHost: "" }
}

interface TokenInfo {
  token: string
  isClaim: boolean
}

function readTokenFromHash(): TokenInfo | null {
  if (typeof window === "undefined") return null
  const h = window.location.hash.slice(1)
  if (!h) return null
  const params = new URLSearchParams(h)
  const claim = params.get("token") || params.get("claim")
  if (claim) return { token: claim, isClaim: true }
  const bearer = params.get("bearer")
  if (bearer) return { token: bearer, isClaim: false }
  return null
}

function tokenKey(deployId: string): string {
  return `pond-ide-token:${deployId}`
}

function loadStoredToken(deployId: string): TokenInfo | null {
  try {
    const raw = window.localStorage.getItem(tokenKey(deployId))
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function storeToken(deployId: string, info: TokenInfo) {
  try {
    window.localStorage.setItem(tokenKey(deployId), JSON.stringify(info))
  } catch {}
}

function clearStoredToken(deployId: string) {
  try {
    window.localStorage.removeItem(tokenKey(deployId))
  } catch {}
}

interface Outline {
  tables: string[]
  queries: string[]
  mutations: string[]
}

function parseOutline(src: string): Outline {
  const grab = (label: string): string[] => {
    const re = new RegExp(`${label}\\s*:\\s*\\{`, "m")
    const m = re.exec(src)
    if (!m) return []
    let i = m.index + m[0].length
    let depth = 1
    let body = ""
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) break
      }
      body += ch
      i++
    }
    const names: string[] = []
    const ident = /(?:^|[,{\s])\s*([a-zA-Z_$][\w$]*)\s*:/g
    let nm: RegExpExecArray | null
    while ((nm = ident.exec(body))) names.push(nm[1])
    return names
  }
  return { tables: grab("schema"), queries: grab("queries"), mutations: grab("mutations") }
}

const REQUIRED_PATHS = new Set(["server/index.ts", "package.json"])

export function App() {
  const bootstrap = useMemo(readBootstrap, [])
  const [token, setToken] = useState<TokenInfo | null>(() => {
    if (!bootstrap.deployId) return null
    const fromHash = readTokenFromHash()
    if (fromHash) {
      storeToken(bootstrap.deployId, fromHash)
      try {
        history.replaceState({}, "", window.location.pathname)
      } catch {}
      return fromHash
    }
    return loadStoredToken(bootstrap.deployId)
  })

  if (!bootstrap.deployId) {
    return <FatalMessage title="No deploy" detail="The IDE was opened without a deploy id." />
  }
  if (!token) {
    return (
      <TokenGate
        onSubmit={(info) => {
          storeToken(bootstrap.deployId, info)
          setToken(info)
        }}
      />
    )
  }
  return (
    <Workspace
      bootstrap={bootstrap}
      token={token}
      onSignOut={() => {
        clearStoredToken(bootstrap.deployId)
        setToken(null)
      }}
    />
  )
}

function FatalMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div class="flex min-h-screen items-center justify-center bg-black text-zinc-200">
      <div class="max-w-md text-center">
        <h1 class="mb-2 text-2xl font-semibold">{title}</h1>
        <p class="text-zinc-400">{detail}</p>
      </div>
    </div>
  )
}

function TokenGate({ onSubmit }: { onSubmit: (info: TokenInfo) => void }) {
  const [token, setToken] = useState("")
  const [kind, setKind] = useState<"claim" | "bearer">("claim")
  return (
    <div class="flex min-h-screen items-center justify-center bg-black text-zinc-200">
      <form
        class="w-full max-w-md space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (token.trim()) onSubmit({ token: token.trim(), isClaim: kind === "claim" })
        }}
      >
        <h1 class="text-xl font-semibold">Open this capsule in the IDE</h1>
        <p class="text-sm text-zinc-400">Paste your claim token (anonymous deploy owner) or your account API token.</p>
        <div class="flex gap-3 text-sm">
          <label class="flex items-center gap-2">
            <input type="radio" name="k" checked={kind === "claim"} onChange={() => setKind("claim")} />
            Claim token
          </label>
          <label class="flex items-center gap-2">
            <input type="radio" name="k" checked={kind === "bearer"} onChange={() => setKind("bearer")} />
            Bearer
          </label>
        </div>
        <input
          type="password"
          class="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-sm outline-none focus:border-zinc-600"
          placeholder="token"
          value={token}
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
        />
        <button class="w-full rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-zinc-200">
          Open
        </button>
      </form>
    </div>
  )
}

interface WorkspaceProps {
  bootstrap: Bootstrap
  token: TokenInfo
  onSignOut: () => void
}

function Workspace({ bootstrap, token, onSignOut }: WorkspaceProps) {
  const opts = useMemo(
    () => ({ deployId: bootstrap.deployId, token: token.token, isClaim: token.isClaim }),
    [bootstrap.deployId, token],
  )
  const [files, setFiles] = useState<FileEntry[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [contents, setContents] = useState<Record<string, { saved: string; draft: string }>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [lastBuild, setLastBuild] = useState<BuildResult | null>(null)
  const [previewKey, setPreviewKey] = useState(0)
  const [showPreview, setShowPreview] = useState(true)
  const [rightTab, setRightTab] = useState<"preview" | "logs" | "env">("preview")
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)

  // Load file list on mount / token change.
  useEffect(() => {
    let cancelled = false
    fetchFiles(opts).then((res) => {
      if (cancelled) return
      if ("error" in res) {
        setLoadError(`${res.error} (HTTP ${res.status})`)
        if (res.status === 401 || res.status === 403) onSignOut()
        return
      }
      setFiles(res.files)
      const seed = res.files.find((f) => f.path === "server/index.ts") ?? res.files[0]
      if (seed && !activePath) void openFile(seed.path)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.deployId, opts.token])

  async function openFile(path: string) {
    if (!(path in contents)) {
      const r = await fetchFile(opts, path)
      if ("error" in r) {
        setLoadError(r.error)
        return
      }
      setContents((c) => ({ ...c, [path]: { saved: r.text, draft: r.text } }))
    }
    setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]))
    setActivePath(path)
  }

  function closeTab(path: string) {
    setOpenTabs((tabs) => tabs.filter((t) => t !== path))
    setActivePath((cur) => {
      if (cur !== path) return cur
      const remaining = openTabs.filter((t) => t !== path)
      return remaining.length ? remaining[remaining.length - 1] : null
    })
  }

  async function saveFile(path: string): Promise<boolean> {
    const entry = contents[path]
    if (!entry) return true
    if (entry.draft === entry.saved) return true
    const r = await putFile(opts, path, entry.draft)
    if ("error" in r) {
      setLoadError(r.error)
      return false
    }
    setContents((c) => ({ ...c, [path]: { saved: entry.draft, draft: entry.draft } }))
    return true
  }

  async function saveAllDirty(): Promise<boolean> {
    for (const [p, v] of Object.entries(contents)) {
      if (v.saved !== v.draft) {
        const ok = await saveFile(p)
        if (!ok) return false
      }
    }
    return true
  }

  async function refreshFiles() {
    const res = await fetchFiles(opts)
    if ("error" in res) return
    setFiles(res.files)
  }

  async function handleDeploy() {
    setBuilding(true)
    try {
      const ok = await saveAllDirty()
      if (!ok) return
      const result = await build(opts)
      setLastBuild(result)
      if (result.ok) {
        setPreviewKey((k) => k + 1)
        await refreshFiles()
      }
    } finally {
      setBuilding(false)
    }
  }

  async function handleNewFile() {
    const path = window.prompt("New file path (e.g. shared/notes.md or client/header.tsx)")
    if (!path) return
    const r = await putFile(opts, path.trim(), "")
    if ("error" in r) {
      setLoadError(r.error)
      return
    }
    await refreshFiles()
    await openFile(path.trim())
  }

  async function handleDelete(path: string) {
    if (REQUIRED_PATHS.has(path)) return
    if (!window.confirm(`Delete ${path}?`)) return
    const r = await deleteFile(opts, path)
    if ("error" in r) {
      setLoadError(r.error)
      return
    }
    setContents((c) => {
      const next = { ...c }
      delete next[path]
      return next
    })
    closeTab(path)
    await refreshFiles()
  }

  async function handleRename(path: string) {
    if (REQUIRED_PATHS.has(path)) return
    const next = window.prompt(`Rename ${path} to:`, path)
    if (!next || next === path) return
    const r = await moveFile(opts, path, next.trim())
    if ("error" in r) {
      setLoadError(r.error)
      return
    }
    setContents((c) => {
      const v = c[path]
      if (!v) return c
      const cn = { ...c, [next.trim()]: v }
      delete cn[path]
      return cn
    })
    setOpenTabs((tabs) => tabs.map((t) => (t === path ? next.trim() : t)))
    if (activePath === path) setActivePath(next.trim())
    await refreshFiles()
  }

  const dirty = useMemo(() => {
    const out = new Set<string>()
    for (const [p, v] of Object.entries(contents)) if (v.saved !== v.draft) out.add(p)
    return out
  }, [contents])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen(true)
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault()
        setSearchOpen(true)
      } else if (e.key === "Escape") {
        setPaletteOpen(false)
        setSearchOpen(false)
        setDiffOpen(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  function attemptDeploy() {
    if (dirty.size > 0) setDiffOpen(true)
    else void handleDeploy()
  }

  const outline = useMemo(() => parseOutline(contents["server/index.ts"]?.draft ?? ""), [contents])
  const bundleBytes = lastBuild?.ok ? lastBuild.bundleBytes : null
  const totalSize = useMemo(() => files.reduce((n, f) => n + f.size, 0), [files])

  return (
    <div class="flex h-screen flex-col bg-black text-zinc-200">
      <Header
        deployId={bootstrap.deployId}
        deployUrl={bootstrap.deployUrl}
        bundleBytes={bundleBytes}
        totalSourceBytes={totalSize}
        dirtyCount={dirty.size}
        building={building}
        onDeploy={attemptDeploy}
        onSignOut={onSignOut}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div class="grid flex-1 grid-cols-[14rem_minmax(0,1fr)_22rem] overflow-hidden">
        <FileTreePane
          files={files}
          activePath={activePath}
          dirty={dirty}
          onOpen={(p) => void openFile(p)}
          onDelete={(p) => void handleDelete(p)}
          onRename={(p) => void handleRename(p)}
          onNewFile={() => void handleNewFile()}
        />
        <EditorPane
          openTabs={openTabs}
          activePath={activePath}
          dirty={dirty}
          contents={contents}
          onChange={(p, next) => setContents((c) => ({ ...c, [p]: { ...c[p], draft: next } }))}
          onSave={(p) => void saveFile(p)}
          onPickTab={(p) => setActivePath(p)}
          onCloseTab={closeTab}
        />
        <RightPane
          outline={outline}
          lastBuild={lastBuild}
          building={building}
          deployUrl={bootstrap.deployUrl}
          previewKey={previewKey}
          showPreview={showPreview}
          onTogglePreview={() => setShowPreview((s) => !s)}
          activeTab={rightTab}
          onTab={setRightTab}
          apiOpts={opts}
        />
      </div>
      {paletteOpen ? (
        <CommandPalette
          files={files}
          onClose={() => setPaletteOpen(false)}
          onOpenFile={(p) => {
            void openFile(p)
            setPaletteOpen(false)
          }}
          onDeploy={() => {
            setPaletteOpen(false)
            attemptDeploy()
          }}
          onTogglePreview={() => {
            setShowPreview((s) => !s)
            setPaletteOpen(false)
          }}
          onSearch={() => {
            setPaletteOpen(false)
            setSearchOpen(true)
          }}
          onSignOut={() => {
            setPaletteOpen(false)
            onSignOut()
          }}
        />
      ) : null}
      {searchOpen ? (
        <GlobalSearch
          contents={contents}
          onClose={() => setSearchOpen(false)}
          onOpenFile={(p) => {
            void openFile(p)
            setSearchOpen(false)
          }}
          onPrefetch={async (path) => {
            if (!(path in contents)) {
              const r = await fetchFile(opts, path)
              if (!("error" in r)) setContents((c) => ({ ...c, [path]: { saved: r.text, draft: r.text } }))
            }
          }}
          files={files}
        />
      ) : null}
      {diffOpen ? (
        <DeployDiff
          contents={contents}
          dirty={dirty}
          onCancel={() => setDiffOpen(false)}
          onConfirm={async () => {
            setDiffOpen(false)
            await handleDeploy()
          }}
        />
      ) : null}
      {loadError ? (
        <div class="border-t border-red-900 bg-red-950 px-4 py-2 text-xs text-red-200">
          {loadError}
          <button class="ml-3 text-red-100 underline" onClick={() => setLoadError(null)}>
            dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}

interface HeaderProps {
  deployId: string
  deployUrl: string
  bundleBytes: number | null
  totalSourceBytes: number
  dirtyCount: number
  building: boolean
  onDeploy: () => void
  onSignOut: () => void
  onOpenPalette: () => void
}

function Header(p: HeaderProps) {
  return (
    <header class="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4 py-3">
      <div>
        <h1 class="text-lg font-semibold leading-tight">pond IDE</h1>
        <p class="text-xs text-zinc-500">
          <a
            class="underline decoration-zinc-700 hover:decoration-zinc-400"
            href={p.deployUrl}
            target="_blank"
            rel="noreferrer"
          >
            {p.deployId}
          </a>{" "}
          · source {(p.totalSourceBytes / 1024).toFixed(1)} KB
          {p.bundleBytes != null ? ` · bundle ${(p.bundleBytes / 1024).toFixed(1)} KB` : ""}
        </p>
      </div>
      <div class="flex items-center gap-2">
        {p.dirtyCount > 0 ? (
          <span class="text-xs text-amber-400">{p.dirtyCount} unsaved</span>
        ) : (
          <span class="text-xs text-zinc-600">saved</span>
        )}
        <button
          class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
          onClick={p.onOpenPalette}
          title="Cmd/Ctrl-K"
        >
          ⌘K
        </button>
        <button
          class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
          onClick={p.onSignOut}
        >
          sign out
        </button>
        <button
          class="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 disabled:opacity-50"
          disabled={p.building}
          onClick={p.onDeploy}
        >
          {p.building ? "Deploying…" : "Deploy →"}
        </button>
      </div>
    </header>
  )
}

interface FileTreeProps {
  files: FileEntry[]
  activePath: string | null
  dirty: Set<string>
  onOpen: (p: string) => void
  onDelete: (p: string) => void
  onRename: (p: string) => void
  onNewFile: () => void
}

function FileTreePane(p: FileTreeProps) {
  const grouped = useMemo(() => {
    const g: Record<string, FileEntry[]> = {}
    for (const f of p.files) {
      const root = f.path.includes("/") ? f.path.split("/")[0] : "."
      ;(g[root] ??= []).push(f)
    }
    return g
  }, [p.files])

  const order = ["server", "client", "shared", "."]
  return (
    <aside class="flex flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-950">
      <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-xs uppercase tracking-wide text-zinc-500">
        <span>Files</span>
        <button
          class="rounded border border-zinc-800 px-2 py-0.5 text-zinc-300 hover:border-zinc-600"
          onClick={p.onNewFile}
        >
          + new
        </button>
      </div>
      {order
        .filter((k) => grouped[k]?.length)
        .map((k) => (
          <div class="border-b border-zinc-900 py-1">
            <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-zinc-600">{k}</div>
            {grouped[k]
              .slice()
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((f) => {
                const isActive = f.path === p.activePath
                const isDirty = p.dirty.has(f.path)
                return (
                  <div
                    class={`group flex items-center justify-between px-3 py-1 text-xs ${isActive ? "bg-zinc-800 text-zinc-50" : "text-zinc-300 hover:bg-zinc-900"}`}
                  >
                    <button class="flex-1 truncate text-left" onClick={() => p.onOpen(f.path)}>
                      {isDirty ? "● " : ""}
                      {f.path}
                    </button>
                    {REQUIRED_PATHS.has(f.path) ? null : (
                      <div class="ml-2 hidden gap-1 text-zinc-500 group-hover:flex">
                        <button title="Rename" class="hover:text-zinc-200" onClick={() => p.onRename(f.path)}>
                          ✎
                        </button>
                        <button title="Delete" class="hover:text-red-400" onClick={() => p.onDelete(f.path)}>
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        ))}
    </aside>
  )
}

interface EditorPaneProps {
  openTabs: string[]
  activePath: string | null
  dirty: Set<string>
  contents: Record<string, { saved: string; draft: string }>
  onChange: (p: string, next: string) => void
  onSave: (p: string) => void
  onPickTab: (p: string) => void
  onCloseTab: (p: string) => void
}

function EditorPane(p: EditorPaneProps) {
  return (
    <section class="flex min-w-0 flex-col bg-black">
      <div class="flex items-center overflow-x-auto border-b border-zinc-800 bg-zinc-950 text-xs">
        {p.openTabs.length === 0 ? (
          <span class="px-4 py-2 text-zinc-600">Open a file from the left</span>
        ) : (
          p.openTabs.map((path) => {
            const isActive = path === p.activePath
            return (
              <div
                class={`flex items-center gap-2 border-r border-zinc-800 px-3 py-2 ${isActive ? "bg-black text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}
              >
                <button onClick={() => p.onPickTab(path)} class="truncate">
                  {p.dirty.has(path) ? "● " : ""}
                  {path}
                </button>
                <button class="text-zinc-600 hover:text-zinc-200" onClick={() => p.onCloseTab(path)}>
                  ×
                </button>
              </div>
            )
          })
        )}
      </div>
      <div class="min-h-0 flex-1">
        {p.activePath && p.contents[p.activePath] ? (
          <CodeMirrorEditor
            path={p.activePath}
            value={p.contents[p.activePath].draft}
            onChange={(next) => p.onChange(p.activePath as string, next)}
            onSave={() => p.onSave(p.activePath as string)}
          />
        ) : (
          <div class="flex h-full items-center justify-center text-zinc-600">
            <span class="text-sm">No file open</span>
          </div>
        )}
      </div>
    </section>
  )
}

interface RightPaneProps {
  outline: Outline
  lastBuild: BuildResult | null
  building: boolean
  deployUrl: string
  previewKey: number
  showPreview: boolean
  onTogglePreview: () => void
  activeTab: "preview" | "logs" | "env"
  onTab: (t: "preview" | "logs" | "env") => void
  apiOpts: { deployId: string; token: string; isClaim: boolean }
}

function RightPane(p: RightPaneProps) {
  return (
    <aside class="flex flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-950">
      <OutlineSection outline={p.outline} />
      <DiagnosticsSection lastBuild={p.lastBuild} building={p.building} />
      <div class="flex border-b border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500">
        {(["preview", "logs", "env"] as const).map((t) => (
          <button
            class={`flex-1 py-2 ${p.activeTab === t ? "bg-black text-zinc-100" : "hover:bg-zinc-900"}`}
            onClick={() => p.onTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {p.activeTab === "preview" ? (
        <PreviewSection
          deployUrl={p.deployUrl}
          previewKey={p.previewKey}
          showPreview={p.showPreview}
          onToggle={p.onTogglePreview}
        />
      ) : p.activeTab === "logs" ? (
        <LogsSection deployUrl={p.deployUrl} apiOpts={p.apiOpts} />
      ) : (
        <EnvSection apiOpts={p.apiOpts} />
      )}
    </aside>
  )
}

function LogsSection({
  deployUrl,
  apiOpts,
}: {
  deployUrl: string
  apiOpts: { deployId: string; token: string; isClaim: boolean }
}) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<"all" | "info" | "error">("all")
  const [err, setErr] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const queuedRef = useRef<LogEntry[]>([])
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    if (!deployUrl) return
    setEntries([])
    setErr(null)
    queuedRef.current = []
    const stop = streamLogs(
      deployUrl,
      apiOpts,
      (entry) => {
        if (pausedRef.current) {
          queuedRef.current.push(entry)
          return
        }
        setEntries((es) => [...es.slice(-499), entry])
      },
      (e) => setErr(e instanceof Error ? e.message : String(e)),
    )
    return stop
  }, [deployUrl, apiOpts.deployId, apiOpts.token])

  useEffect(() => {
    if (!paused && queuedRef.current.length) {
      const flushed = queuedRef.current
      queuedRef.current = []
      setEntries((es) => [...es.slice(-(500 - flushed.length)), ...flushed])
    }
  }, [paused])

  useEffect(() => {
    if (paused) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, paused])

  const filtered = filter === "all" ? entries : entries.filter((e) => e.level === filter)

  return (
    <div
      class="flex min-h-[18rem] flex-col px-3 py-3"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div class="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
        <span>Logs {paused ? "(paused)" : ""}</span>
        <div class="flex gap-1 text-[10px]">
          {(["all", "info", "error"] as const).map((f) => (
            <button
              class={`rounded px-2 py-0.5 ${filter === f ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={scrollRef as any}
        class="h-72 overflow-y-auto rounded border border-zinc-800 bg-black p-2 font-mono text-[10px]"
      >
        {err ? <div class="text-red-400">{err}</div> : null}
        {filtered.length === 0 ? <div class="text-zinc-600">No log entries yet.</div> : null}
        {filtered.map((e, i) => (
          <div key={i} class={e.level === "error" ? "text-red-300" : "text-zinc-300"}>
            <span class="text-zinc-600">{e.timestamp.slice(11, 19)} </span>
            {e.message}
            {e.data ? <span class="text-zinc-500"> {JSON.stringify(e.data)}</span> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function EnvSection({ apiOpts }: { apiOpts: { deployId: string; token: string; isClaim: boolean } }) {
  const [entries, setEntries] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null)
  const [newKey, setNewKey] = useState("")
  const [newValue, setNewValue] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchEnv(apiOpts).then((res) => {
      if (cancelled) return
      if ("error" in res) {
        setErr(res.error)
      } else {
        setEntries(res.entries)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [apiOpts.deployId, apiOpts.token])

  async function save(key: string, value: string) {
    setErr(null)
    const res = await putEnv(apiOpts, { [key]: value })
    if ("error" in res) {
      setErr(res.error)
      return
    }
    setEntries(res.entries)
  }

  async function remove(key: string) {
    if (!confirm(`Delete ${key}?`)) return
    setErr(null)
    const res = await deleteEnvKey(apiOpts, key)
    if ("error" in res) {
      setErr(res.error)
      return
    }
    setEntries(res.entries)
  }

  function mask(v: string): string {
    if (v.length <= 4) return "•".repeat(v.length)
    return v.slice(0, 2) + "…" + v.slice(-2)
  }

  return (
    <div class="flex min-h-[18rem] flex-col px-3 py-3">
      <div class="mb-2 text-xs uppercase tracking-wide text-zinc-500">Env (.env.pond.server)</div>
      {err ? (
        <div class="mb-2 rounded border border-red-900 bg-red-950 px-2 py-1 text-[10px] text-red-200">{err}</div>
      ) : null}
      {loading ? <div class="text-xs text-zinc-500">Loading…</div> : null}
      <div class="space-y-1">
        {Object.keys(entries)
          .sort()
          .map((k) => {
            const isEditing = editing?.key === k
            return (
              <div
                key={k}
                class="flex items-center gap-2 rounded border border-zinc-800 bg-black px-2 py-1 text-[11px]"
              >
                <span class="w-28 truncate text-zinc-300">{k}</span>
                {isEditing ? (
                  <input
                    class="flex-1 rounded border border-zinc-700 bg-black px-2 py-0.5 text-zinc-100"
                    value={editing!.value}
                    onInput={(e) => setEditing({ key: k, value: (e.target as HTMLInputElement).value })}
                  />
                ) : (
                  <span class="flex-1 truncate text-zinc-500">{mask(entries[k])}</span>
                )}
                {isEditing ? (
                  <Fragment>
                    <button
                      class="rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-950"
                      onClick={async () => {
                        await save(k, editing!.value)
                        setEditing(null)
                      }}
                    >
                      save
                    </button>
                    <button class="text-[10px] text-zinc-500" onClick={() => setEditing(null)}>
                      cancel
                    </button>
                  </Fragment>
                ) : (
                  <Fragment>
                    <button
                      class="text-[10px] text-zinc-400 hover:text-zinc-100"
                      onClick={() => setEditing({ key: k, value: entries[k] })}
                    >
                      edit
                    </button>
                    <button class="text-[10px] text-red-400 hover:text-red-300" onClick={() => void remove(k)}>
                      ×
                    </button>
                  </Fragment>
                )}
              </div>
            )
          })}
      </div>
      <div class="mt-3 border-t border-zinc-800 pt-3">
        <div class="mb-1 text-[10px] uppercase text-zinc-500">Add new</div>
        <div class="flex flex-wrap items-center gap-1">
          <input
            class="w-28 rounded border border-zinc-700 bg-black px-2 py-0.5 text-[11px]"
            placeholder="KEY"
            value={newKey}
            onInput={(e) => setNewKey((e.target as HTMLInputElement).value.toUpperCase())}
          />
          <input
            class="flex-1 rounded border border-zinc-700 bg-black px-2 py-0.5 text-[11px]"
            placeholder="value"
            value={newValue}
            onInput={(e) => setNewValue((e.target as HTMLInputElement).value)}
          />
          <button
            class="rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-950 disabled:opacity-40"
            disabled={!newKey || !newValue}
            onClick={async () => {
              await save(newKey, newValue)
              setNewKey("")
              setNewValue("")
            }}
          >
            add
          </button>
        </div>
      </div>
    </div>
  )
}

function OutlineSection({ outline }: { outline: Outline }) {
  const totals = outline.tables.length + outline.queries.length + outline.mutations.length
  return (
    <div class="border-b border-zinc-800 px-3 py-3">
      <div class="mb-2 text-xs uppercase tracking-wide text-zinc-500">Outline</div>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <OutlineCell label="Tables" items={outline.tables} />
        <OutlineCell label="Queries" items={outline.queries} />
        <OutlineCell label="Mutations" items={outline.mutations} />
        <div class="rounded border border-zinc-800 bg-black p-2">
          <div class="text-zinc-500">Total</div>
          <div class="text-lg font-semibold text-zinc-100">{totals}</div>
        </div>
      </div>
    </div>
  )
}

function OutlineCell({ label, items }: { label: string; items: string[] }) {
  return (
    <div class="rounded border border-zinc-800 bg-black p-2">
      <div class="text-zinc-500">{label}</div>
      <div class="text-lg font-semibold text-zinc-100">{items.length}</div>
      {items.length ? (
        <div class="mt-1 truncate text-[10px] text-zinc-500">
          {items.slice(0, 3).join(", ")}
          {items.length > 3 ? "…" : ""}
        </div>
      ) : null}
    </div>
  )
}

function DiagnosticsSection({ lastBuild, building }: { lastBuild: BuildResult | null; building: boolean }) {
  return (
    <div class="border-b border-zinc-800 px-3 py-3">
      <div class="mb-2 text-xs uppercase tracking-wide text-zinc-500">Diagnostics</div>
      {building ? (
        <div class="text-xs text-zinc-400">Building…</div>
      ) : !lastBuild ? (
        <div class="text-xs text-zinc-600">No build yet. Hit Deploy to compile.</div>
      ) : lastBuild.ok ? (
        <div class="rounded border border-emerald-900 bg-emerald-950 px-2 py-1.5 text-xs text-emerald-300">
          ✓ Built in {lastBuild.durationMs}ms · {(lastBuild.bundleBytes / 1024).toFixed(1)} KB
        </div>
      ) : (
        <ul class="space-y-1 text-xs">
          {lastBuild.errors.map((e) => (
            <li class="rounded border border-red-900 bg-red-950 px-2 py-1.5 text-red-200">
              {e.file ? (
                <span class="mr-1 text-red-400">
                  {e.file}
                  {e.line ? `:${e.line}` : ""}
                </span>
              ) : null}
              {e.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PreviewSection({
  deployUrl,
  previewKey,
  showPreview,
  onToggle,
}: {
  deployUrl: string
  previewKey: number
  showPreview: boolean
  onToggle: () => void
}) {
  return (
    <div class="flex min-h-[18rem] flex-col px-3 py-3">
      <div class="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
        <span>Preview</span>
        <button class="text-[10px] uppercase text-zinc-400 hover:text-zinc-200" onClick={onToggle}>
          {showPreview ? "hide" : "show"}
        </button>
      </div>
      {showPreview && deployUrl ? (
        <Fragment>
          <iframe
            key={previewKey}
            src={deployUrl}
            class="h-72 w-full rounded border border-zinc-800 bg-black"
            sandbox="allow-scripts allow-forms allow-same-origin"
          />
          <a
            class="mt-2 truncate text-[10px] text-zinc-500 underline"
            href={deployUrl}
            target="_blank"
            rel="noreferrer"
          >
            {deployUrl}
          </a>
        </Fragment>
      ) : (
        <div class="rounded border border-zinc-800 bg-black p-3 text-xs text-zinc-500">Preview hidden.</div>
      )}
    </div>
  )
}

interface PaletteCommand {
  label: string
  hint: string
  run: () => void
}

function CommandPalette({
  files,
  onClose,
  onOpenFile,
  onDeploy,
  onTogglePreview,
  onSearch,
  onSignOut,
}: {
  files: FileEntry[]
  onClose: () => void
  onOpenFile: (path: string) => void
  onDeploy: () => void
  onTogglePreview: () => void
  onSearch: () => void
  onSignOut: () => void
}) {
  const [q, setQ] = useState("")
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const commands: PaletteCommand[] = [
    { label: "Deploy", hint: "build + restart", run: onDeploy },
    { label: "Toggle preview", hint: "show/hide iframe", run: onTogglePreview },
    { label: "Global search", hint: "Cmd-Shift-F", run: onSearch },
    { label: "Sign out", hint: "clear token", run: onSignOut },
  ]

  const items = useMemo(() => {
    const fq = q.toLowerCase()
    const fileMatches = files
      .filter((f) => f.path.toLowerCase().includes(fq))
      .slice(0, 20)
      .map((f) => ({ kind: "file" as const, path: f.path, label: f.path, hint: "open" }))
    const cmdMatches = commands
      .filter((c) => c.label.toLowerCase().includes(fq))
      .map((c) => ({ kind: "cmd" as const, ...c }))
    return q ? [...fileMatches, ...cmdMatches] : [...cmdMatches, ...fileMatches]
  }, [q, files])

  function run(i: number) {
    const item = items[i]
    if (!item) return
    if (item.kind === "file") onOpenFile(item.path)
    else item.run()
  }

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-24" onClick={onClose}>
      <div
        class="w-full max-w-xl overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef as any}
          class="w-full border-b border-zinc-800 bg-black px-4 py-3 text-sm outline-none"
          placeholder="Search files or commands..."
          value={q}
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value)
            setIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              setIdx((i) => Math.min(items.length - 1, i + 1))
              e.preventDefault()
            } else if (e.key === "ArrowUp") {
              setIdx((i) => Math.max(0, i - 1))
              e.preventDefault()
            } else if (e.key === "Enter") {
              run(idx)
            }
          }}
        />
        <ul class="max-h-96 overflow-y-auto">
          {items.map((it, i) => (
            <li
              key={i}
              class={`flex cursor-pointer items-center justify-between px-4 py-2 text-sm ${i === idx ? "bg-zinc-800 text-zinc-50" : "text-zinc-300 hover:bg-zinc-900"}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => run(i)}
            >
              <span class="truncate">{it.label}</span>
              <span class="ml-3 text-[10px] text-zinc-500">{it.hint}</span>
            </li>
          ))}
          {items.length === 0 ? <li class="px-4 py-2 text-sm text-zinc-500">No matches</li> : null}
        </ul>
      </div>
    </div>
  )
}

function GlobalSearch({
  contents,
  files,
  onClose,
  onOpenFile,
  onPrefetch,
}: {
  contents: Record<string, { saved: string; draft: string }>
  files: FileEntry[]
  onClose: () => void
  onOpenFile: (path: string) => void
  onPrefetch: (path: string) => Promise<void>
}) {
  const [q, setQ] = useState("")
  const [results, setResults] = useState<Array<{ path: string; line: number; text: string }>>([])
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!q || q.length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    void (async () => {
      // Lazily load any files we don't have yet so search covers the whole tree.
      for (const f of files) {
        if (!(f.path in contents)) await onPrefetch(f.path)
        if (cancelled) return
      }
      const next: Array<{ path: string; line: number; text: string }> = []
      const ql = q.toLowerCase()
      for (const [path, v] of Object.entries(contents)) {
        const lines = v.draft.split("\n")
        for (let i = 0; i < lines.length && next.length < 200; i++) {
          if (lines[i].toLowerCase().includes(ql)) {
            next.push({ path, line: i + 1, text: lines[i].trim().slice(0, 200) })
          }
        }
      }
      if (!cancelled) setResults(next)
    })()
    return () => {
      cancelled = true
    }
  }, [q, files, contents])

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-16" onClick={onClose}>
      <div
        class="w-full max-w-2xl overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef as any}
          class="w-full border-b border-zinc-800 bg-black px-4 py-3 text-sm outline-none"
          placeholder="Search across all source files..."
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <ul class="max-h-[28rem] overflow-y-auto">
          {results.map((r, i) => (
            <li
              key={i}
              class="cursor-pointer border-b border-zinc-900 px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-900"
              onClick={() => onOpenFile(r.path)}
            >
              <div class="text-zinc-500">
                {r.path}:{r.line}
              </div>
              <div class="truncate font-mono text-zinc-100">{r.text}</div>
            </li>
          ))}
          {q && results.length === 0 ? <li class="px-4 py-3 text-xs text-zinc-500">No matches.</li> : null}
        </ul>
      </div>
    </div>
  )
}

function DeployDiff({
  contents,
  dirty,
  onCancel,
  onConfirm,
}: {
  contents: Record<string, { saved: string; draft: string }>
  dirty: Set<string>
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onCancel}>
      <div
        class="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <h2 class="text-sm font-semibold">
              Deploy {dirty.size} unsaved file{dirty.size === 1 ? "" : "s"}?
            </h2>
            <p class="text-[11px] text-zinc-500">Review changes — confirm to save + build.</p>
          </div>
          <div class="flex gap-2">
            <button
              class="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              class="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-zinc-200"
              onClick={onConfirm}
            >
              Save + Deploy →
            </button>
          </div>
        </header>
        <div class="flex-1 overflow-y-auto">
          {[...dirty].map((path) => (
            <DiffBlock key={path} path={path} saved={contents[path]?.saved ?? ""} draft={contents[path]?.draft ?? ""} />
          ))}
        </div>
      </div>
    </div>
  )
}

function DiffBlock({ path, saved, draft }: { path: string; saved: string; draft: string }) {
  const savedLines = saved.split("\n")
  const draftLines = draft.split("\n")
  // Tiny inline diff: collect adds/removes line-by-line. Not a real LCS — fast
  // enough and good enough for the typical pre-deploy review window.
  const maxLen = Math.max(savedLines.length, draftLines.length)
  const rows: Array<{ kind: "same" | "add" | "del"; text: string }> = []
  for (let i = 0; i < maxLen; i++) {
    const a = savedLines[i]
    const b = draftLines[i]
    if (a === b) {
      rows.push({ kind: "same", text: a ?? "" })
    } else {
      if (a != null) rows.push({ kind: "del", text: a })
      if (b != null) rows.push({ kind: "add", text: b })
    }
  }

  return (
    <div class="border-b border-zinc-800">
      <div class="bg-zinc-900 px-4 py-2 text-xs text-zinc-300">{path}</div>
      <pre class="overflow-x-auto bg-black px-4 py-2 font-mono text-[11px] leading-relaxed">
        {rows.map((r, i) => (
          <div
            key={i}
            class={
              r.kind === "add"
                ? "bg-emerald-950/60 text-emerald-200"
                : r.kind === "del"
                  ? "bg-red-950/60 text-red-200"
                  : "text-zinc-500"
            }
          >
            {r.kind === "add" ? "+ " : r.kind === "del" ? "- " : "  "}
            {r.text}
          </div>
        ))}
      </pre>
    </div>
  )
}
