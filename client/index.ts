import { render, h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";

// ── API helpers ────────────────────────────────────────────

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── useQuery ───────────────────────────────────────────────

export function useQuery<T = any>(name: string): T | undefined {
  const [data, setData] = useState<T | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    apiFetch<T>(`/api/query/${name}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [name]);

  return data;
}

// ── useMutation ────────────────────────────────────────────

export function useMutation<TArgs extends any[] = any[], TResult = any>(
  name: string
): (...args: TArgs) => Promise<TResult> {
  return useCallback(
    (...args: TArgs) =>
      apiFetch<TResult>(`/api/mutation/${name}`, {
        method: "POST",
        body: JSON.stringify({ args }),
      }),
    [name]
  );
}

// ── useAuth ────────────────────────────────────────────────

export interface AuthState {
  isLoading: boolean;
  isGuest: boolean;
  userId: string;
  displayName?: string;
  picture?: string;
}

export function useAuth(): AuthState {
  const [auth, setAuth] = useState<AuthState>({
    isLoading: true,
    isGuest: true,
    userId: "guest",
  });

  useEffect(() => {
    // For alpha: all users are guests
    setAuth({
      isLoading: false,
      isGuest: true,
      userId: "guest",
      displayName: "Guest",
    });
  }, []);

  return auth;
}

// ── Auth components ────────────────────────────────────────

export function SignInWithGoogle() {
  return null; // Alpha: no Google auth yet
}

export function signOut() {
  // Alpha: no-op
}

// ── Re-export Preact ───────────────────────────────────────

export { render, h };
