// Cloudflare Turnstile server-side verification, factored out so the network
// call can be unit-tested by injecting a fetch stub. When the host runs with no
// Turnstile secret configured the caller skips this entirely (no-op) — see the
// anonymous-deploy handler in src/commands/host.ts.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

export interface TurnstileResult {
  ok: boolean
  errorCodes?: string[]
}

type FetchLike = (
  input: string,
  init: { method: string; body: URLSearchParams; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  json: () => Promise<unknown>
}>

// Hard cap on the siteverify round-trip. Without it a hung Cloudflare connection
// blocks the anonymous-deploy request handler indefinitely; on timeout the fetch
// aborts, throws, and we fail closed below.
const SITEVERIFY_TIMEOUT_MS = 5000

// Verify a client-supplied Turnstile token against Cloudflare's siteverify
// endpoint. `remoteIp` is optional context Cloudflare cross-checks. Any network,
// timeout, or parse failure resolves to `{ ok: false }` so the caller fails closed.
export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | undefined,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<TurnstileResult> {
  if (!token) return { ok: false, errorCodes: ["missing-input-response"] }
  const body = new URLSearchParams()
  body.set("secret", secret)
  body.set("response", token)
  if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp)
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, errorCodes: ["siteverify-http-error"] }
    const data = (await res.json()) as { success?: unknown; "error-codes"?: unknown }
    const errorCodes = Array.isArray(data["error-codes"]) ? (data["error-codes"] as string[]) : undefined
    return { ok: data.success === true, errorCodes }
  } catch {
    return { ok: false, errorCodes: ["siteverify-unreachable"] }
  }
}
