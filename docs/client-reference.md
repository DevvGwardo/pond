# Pond Client API Reference

**Use this as the quick contract when building a Pond capsule client.** If you are an agent writing the UI, this page is the authoritative list of the hooks and components you may import from `pond/client`. Stick to the exports listed here — do not bring in React directly, do not pull in routing or query libraries from npm. Preact is the renderer; Tailwind classes are available without configuration.

This is the surface exported from `pond/client`. A capsule's `client/index.tsx` imports it to call queries, run mutations, and read auth state.

```ts
import { useQuery, useMutation, useAuth, SignInWithGoogle, signOut, render, h } from "pond/client"
```

The client is Preact-based. `render` and `h` are re-exported from Preact for convenience.

---

## `useQuery<T>(name): { data, isLoading, error, refetch }`

Subscribes to a server query mounted at `GET /api/query/<name>`. Re-fetches whenever any mutation completes.

```tsx
function MessageList() {
  const { data, isLoading, error, refetch } = useQuery<Message[]>("messages")
  if (isLoading) return <div>loading…</div>
  if (error) return <div>error: {error.message}</div>
  return (
    <ul>
      {data?.map((m) => (
        <li key={m.id}>{m.body}</li>
      ))}
    </ul>
  )
}
```

### Return shape

| Field       | Type                  | Meaning                                                              |
| ----------- | --------------------- | -------------------------------------------------------------------- |
| `data`      | `T \| undefined`      | The most recent successful response, or undefined before first load. |
| `isLoading` | `boolean`             | True during the first load and during any refetch.                   |
| `error`     | `Error \| null`       | Set if the last fetch threw. Cleared on next successful refetch.     |
| `refetch`   | `() => Promise<void>` | Manually re-runs the query.                                          |

### Auto-refetch

Every component that calls `useQuery("foo")` subscribes to a shared listener set keyed by name. When any `useMutation` completes successfully, every active query refetches. This is intentionally aggressive — pond is for small apps where the network round-trip is cheap.

---

## `useMutation<TArgs, TResult>(name): [run, { isLoading, error }]`

Calls a server mutation at `POST /api/mutation/<name>`. Returns a tuple of the runner and the current state.

```tsx
function SendMessage() {
  const [send, { isLoading, error }] = useMutation<[string], Message>("sendMessage")
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        const body = new FormData(e.currentTarget).get("body") as string
        await send(body)
      }}
    >
      <input name="body" />
      <button type="submit" disabled={isLoading}>
        send
      </button>
      {error && <div>{error.message}</div>}
    </form>
  )
}
```

The runner takes the same positional arguments the server mutation declares. Successful calls automatically refetch every active query.

---

## `useAuth(): AuthState`

Reads the current session via `GET /auth/me`.

```ts
interface AuthState {
  isLoading: boolean
  isGuest: boolean
  userId: string
  displayName?: string
  picture?: string
  email?: string
}
```

```tsx
function Header() {
  const auth = useAuth()
  if (auth.isLoading) return null
  if (auth.isGuest) return <SignInWithGoogle />
  return (
    <div>
      {auth.displayName} <button onClick={signOut}>sign out</button>
    </div>
  )
}
```

The hook listens for a `pond:auth-changed` window event and refetches when fired. `signOut()` dispatches that event after calling the server, so any `useAuth` consumer updates automatically.

---

## `SignInWithGoogle(props)`

A button that navigates to `/auth/google`. Pass any HTML button props to override styling or behavior; pass `onClick` to intercept (call `event.preventDefault()` to suppress the navigation).

```tsx
<SignInWithGoogle class="rounded px-3 py-2 bg-white text-black" />
```

Requires Google OAuth env vars on the server (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`).

---

## `signOut(): Promise<void>`

Posts to `/auth/signout` and dispatches `pond:auth-changed` so active `useAuth` hooks refetch.

---

## `render`, `h`

Re-exported from `preact`. Use them to mount your root component if you need to do it manually. The bundler-generated HTML shell already mounts `<App />` for you, so most capsules don't need these directly.

---

## Related docs

- [`docs/api-reference.md`](./api-reference.md) — server-side API reference (`pond/server`).
- `README.md` — overall introduction and runtime model.
