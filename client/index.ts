// Pond client — the capsule-side UI runtime. Exposes Preact hooks that map
// 1:1 onto the capsule server's schema:
//
//   useQuery(name, ...args)      — subscribe to a query; refetches when any
//                                  mutation in the app succeeds
//   useMutation(name)            — run a mutation, then refresh all queries
//   useAuth() / SignInWithGoogle — session state + OAuth entry point
//   signOut()                    — clear the session
//
// Also re-exports preact's `render`/`h` so capsule UIs don't need their own
// preact install.
import { render, h } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

// Default timeout for capsule API calls (ms). A hung connection should
// surface as an error, not leave isLoading stuck true forever. Pass
// `timeoutMs` to apiFetch to override for a specific call.
const DEFAULT_TIMEOUT_MS = 60_000

// Combine a caller signal with a timeout into one signal. AbortSignal.any is
// too new for some target browsers, so wire them by hand.
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter(Boolean) as AbortSignal[]
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  for (const s of present) {
    if (s.aborted) {
      controller.abort()
      break
    }
    s.addEventListener("abort", onAbort, { once: true })
  }
  return controller.signal
}

/**
 * Fetch a capsule API route and parse JSON. Throws an Error that includes the
 * server's error body (when present), so callers can tell a schema error from
 * a 500. `options.headers` are merged over the defaults rather than replacing
 * them. `timeoutMs` bounds the whole request; pass `null` to disable.
 */
async function apiFetch<T>(
  path: string,
  options?: RequestInit,
  timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const headers = new Headers(options?.headers)
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  const res = await fetch(path, {
    ...options,
    headers,
    signal: combineSignals(
      timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
      options?.signal ?? undefined,
    ),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const detail = body ? ` — ${body.slice(0, 300)}` : ""
    throw new Error(`API error: ${res.status}${detail}`)
  }
  // Mutations that return void send an empty body — calling res.json() on that
  // throws "Unexpected end of JSON input". Read text first, parse only if present.
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const activeQueries = new Map<string, Set<() => Promise<void>>>()

function subscribeQuery(name: string, refetch: () => Promise<void>) {
  const listeners = activeQueries.get(name) ?? new Set<() => Promise<void>>()
  listeners.add(refetch)
  activeQueries.set(name, listeners)
  return () => {
    listeners.delete(refetch)
    if (listeners.size === 0) {
      activeQueries.delete(name)
    }
  }
}

/**
 * Refetch every subscribed query. Settled, not all: one query's network blip
 * must not make a SUCCESSFUL mutation report failure to its caller.
 */
async function refetchAllQueries() {
  const jobs = [...activeQueries.values()].flatMap((listeners) => [...listeners].map((listener) => listener()))
  await Promise.allSettled(jobs)
}

export interface QueryResult<T> {
  /** Last successful result. Undefined until the first fetch resolves. */
  data: T | undefined
  /** True while a fetch is in flight (including after an explicit refetch). */
  isLoading: boolean
  /** Last error, or null. Failed refetches keep the previous data. */
  error: Error | null
  /** Re-run the query now. */
  refetch: () => Promise<void>
}

/**
 * Subscribe to a capsule query.
 *
 * @param name — the query name from `capsule({ queries: { ... } })`
 * @param args — positional arguments passed to the query handler
 *
 * The result is refetched automatically whenever any `useMutation` succeeds
 * in the app (so the UI stays consistent after writes). Changing `name` or
 * `args` refetches; an in-flight fetch is aborted on unmount.
 */
export function useQuery<T = any, TArgs extends any[] = []>(name: string, ...args: TArgs): QueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const refetchRef = useRef<() => Promise<void>>(async () => {})
  const argsKey = args.length === 0 ? "" : JSON.stringify(args)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const hasArgs = argsKey !== ""

    const refetch = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const next = hasArgs
          ? await apiFetch<T>(`/api/query/${name}`, {
              method: "POST",
              body: argsKey ? `{"args":${argsKey}}` : "{}",
              signal: controller.signal,
            })
          : await apiFetch<T>(`/api/query/${name}`, { signal: controller.signal })
        if (!cancelled) setData(next)
      } catch (err) {
        if (!cancelled && (err as { name?: string }).name !== "AbortError") {
          setError(err instanceof Error ? err : new Error("Unknown query error"))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    refetchRef.current = refetch
    const unsubscribe = subscribeQuery(name, refetch)
    void refetch()

    return () => {
      cancelled = true
      controller.abort()
      unsubscribe()
    }
  }, [name, argsKey])

  return {
    data,
    isLoading,
    error,
    refetch: async () => await refetchRef.current(),
  }
}

export interface MutationResult<TResult> {
  /** True while the mutation (and its query refetch pass) is in flight. */
  isLoading: boolean
  /** Last error, or null. */
  error: Error | null
}

/**
 * Run a capsule mutation and refresh every subscribed query on success.
 *
 * @param name — the mutation name from `capsule({ mutations: { ... } })`
 * @returns `[run, state]` where `run(...args)` performs the mutation and
 *          resolves with its result (or rejects with an Error carrying the
 *          server's message).
 */
export function useMutation<TArgs extends any[] = any[], TResult = any>(
  name: string,
): [(...args: TArgs) => Promise<TResult>, MutationResult<TResult>] {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  return [
    async (...args: TArgs) => {
      setIsLoading(true)
      setError(null)
      try {
        const result = await apiFetch<TResult>(`/api/mutation/${name}`, {
          method: "POST",
          body: JSON.stringify({ args }),
        })
        await refetchAllQueries()
        return result
      } catch (err) {
        const nextError = err instanceof Error ? err : new Error("Unknown mutation error")
        setError(nextError)
        throw nextError
      } finally {
        setIsLoading(false)
      }
    },
    { isLoading, error },
  ]
}

export interface AuthState {
  isLoading: boolean
  isGuest: boolean
  userId: string
  displayName?: string
  picture?: string
  email?: string
}

const defaultAuthState: AuthState = {
  isLoading: true,
  isGuest: true,
  userId: "guest",
}

/**
 * Subscribe to the current session. `isGuest` is true for anonymous visitors;
 * after an OAuth sign-in the component re-renders with the signed-in profile.
 * Listens for `pond:auth-changed` events (dispatched by `signOut` and the
 * server's OAuth flow).
 */
export function useAuth(): AuthState {
  const [auth, setAuth] = useState<AuthState>(defaultAuthState)

  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      setAuth((current) => ({ ...current, isLoading: true }))
      try {
        const next = await apiFetch<Omit<AuthState, "isLoading">>("/auth/me")
        if (!cancelled) {
          setAuth({ ...next, isLoading: false })
        }
      } catch {
        if (!cancelled) {
          setAuth({ ...defaultAuthState, isLoading: false })
        }
      }
    }

    const onAuthChanged = () => {
      void refresh()
    }

    window.addEventListener("pond:auth-changed", onAuthChanged)
    void refresh()

    return () => {
      cancelled = true
      window.removeEventListener("pond:auth-changed", onAuthChanged)
    }
  }, [])

  return auth
}

/**
 * A "Sign in with Google" button. Wired to the capsule's `/auth/google`
 * flow; the page redirects to Google and back, and `useAuth` picks up the
 * new session on return. Extra props (className, disabled, ...) pass through
 * to the button; `onClick` runs first and can `preventDefault()` to stop the
 * redirect.
 */
export function SignInWithGoogle(props: Record<string, any> = {}) {
  const { onClick, type, ...rest } = props

  return h(
    "button",
    {
      type: type ?? "button",
      ...rest,
      onClick: (event: MouseEvent) => {
        onClick?.(event)
        if (!event.defaultPrevented) {
          window.location.href = "/auth/google"
        }
      },
    },
    "Sign in with Google",
  )
}

/** Sign the current session out, then notify every `useAuth` subscriber. */
export async function signOut() {
  await apiFetch("/auth/signout", { method: "POST" })
  window.dispatchEvent(new Event("pond:auth-changed"))
}

export { render, h }
