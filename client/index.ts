import { render, h } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
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

async function refetchAllQueries() {
  const jobs = [...activeQueries.values()].flatMap((listeners) => [...listeners].map((listener) => listener()))
  await Promise.all(jobs)
}

export function useQuery<T = any>(name: string): {
  data: T | undefined
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
} {
  const [data, setData] = useState<T | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const refetchRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    let cancelled = false

    const refetch = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const next = await apiFetch<T>(`/api/query/${name}`)
        if (!cancelled) setData(next)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error("Unknown query error"))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    refetchRef.current = refetch
    const unsubscribe = subscribeQuery(name, refetch)
    void refetch()

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [name])

  return {
    data,
    isLoading,
    error,
    refetch: async () => await refetchRef.current(),
  }
}

export function useMutation<TArgs extends any[] = any[], TResult = any>(
  name: string
): [(...args: TArgs) => Promise<TResult>, { isLoading: boolean; error: Error | null }] {
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
    "Sign in with Google"
  )
}

export async function signOut() {
  await apiFetch("/auth/signout", { method: "POST" })
  window.dispatchEvent(new Event("pond:auth-changed"))
}

export { render, h }
