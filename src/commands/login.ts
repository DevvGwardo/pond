import { defineCommand } from "citty"
import { loadCredentials, saveCredentials } from "../host/credentials.js"

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description: "Bootstrap or attach a user identity for a pond control plane",
  },
  args: {
    api: {
      type: "string",
      required: false,
      default: "https://pond.run",
      description: "Control plane URL (default: https://pond.run)",
    },
    username: { type: "string", required: false },
    token: { type: "string", required: false, description: "Existing user token to attach" },
    "admin-token": {
      type: "string",
      required: false,
      description: "Admin user token to create a new user (admin-only)",
    },
  },
  async run({ args }) {
    // Catch the common citty footgun: an empty `--api` swallows the next flag
    // ("--username") as its value, then complains it can't reach a control
    // plane at "--username". Detect & explain instead.
    const apiRaw = String(args.api ?? "")
    if (apiRaw.startsWith("--") || apiRaw === "") {
      console.error(
        `--api expects a URL value, got "${apiRaw || "(empty)"}". Try \`pond login --username <name> --token <token>\` — --api defaults to https://pond.run.`,
      )
      process.exit(1)
    }
    const apiUrl = apiRaw.replace(/\/$/, "")
    const username = typeof args.username === "string" ? args.username : ""
    const token = typeof args.token === "string" ? args.token : ""
    const adminToken = typeof args["admin-token"] === "string" ? args["admin-token"] : ""

    if (token) {
      if (!username) {
        console.error("--token requires --username (label for the saved credential)")
        process.exit(1)
      }
      const meRes = await fetch(`${apiUrl}/api/users/me`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!meRes.ok) {
        console.error(`Token rejected: ${meRes.status}`)
        process.exit(1)
      }
      const me = (await meRes.json()) as { username: string; isAdmin: boolean }
      const saved = saveCredentials({ apiUrl, username: me.username, token, isAdmin: me.isAdmin })
      console.log(`Logged in as ${saved.username}${saved.isAdmin ? " (admin)" : ""} at ${saved.apiUrl}`)
      console.log(`  Dashboard: ${saved.apiUrl}/dashboard  (or: pond dashboard)`)
      return
    }

    // No --token. Before falling through to the create/attach flow (which
    // requires admin-token or POND_HOST_TOKEN), check whether this machine
    // already has a usable credential for the target apiUrl. If so, validate
    // it server-side and surface "you're already logged in" — no token paste
    // required. This is the common case after `pond signup` saved credentials.
    const existing = loadCredentials(apiUrl)
    if (existing) {
      const usernameMismatch = username && username !== existing.username
      if (usernameMismatch) {
        console.error(
          `You're already logged in at ${apiUrl} as "${existing.username}", not "${username}". ` +
            `Usernames are case-sensitive. To attach as "${username}" you'll need its token: ` +
            `\`pond login --username ${username} --token <token>\`. To use the saved credential, ` +
            `omit --username (or pass --username ${existing.username}).`,
        )
        process.exit(1)
      }
      // Three response classes:
      //   network failure (fetch threw)   → trust the saved cred, warn
      //   server returned 401/403/404     → cred is stale or revoked; refuse
      //                                     to act on it (don't silently use
      //                                     a token the server has rejected)
      //   server returned 2xx             → validated; show the live values
      //   other 5xx / unexpected status   → treat like network failure
      //                                     (transient; saved cred probably
      //                                     still good)
      let meRes: Response | null = null
      let networkErr: unknown = null
      try {
        meRes = await fetch(`${apiUrl}/api/users/me`, {
          headers: { authorization: `Bearer ${existing.token}` },
        })
      } catch (err) {
        networkErr = err
      }
      if (meRes && meRes.ok) {
        const me = (await meRes.json()) as { username: string; isAdmin: boolean }
        console.log(
          `Already logged in as ${me.username}${me.isAdmin ? " (admin)" : ""} at ${existing.apiUrl}  (credential from ~/.pond/credentials.json)`,
        )
        console.log(`  Dashboard: ${existing.apiUrl}/dashboard  (or: pond dashboard)`)
        return
      }
      const status = meRes?.status ?? 0
      const isAuthFailure = status === 401 || status === 403 || status === 404
      if (isAuthFailure) {
        // Server actively rejected the saved token — it has been rotated or
        // revoked. Don't silently overwrite or trust it.
        console.error(
          `Saved credential for "${existing.username}" at ${apiUrl} no longer validates (server said ${status}). ` +
            `Re-attach with \`pond login --username ${existing.username} --token <token>\` after rotating, ` +
            `or pass --admin-token to create a new user.`,
        )
        process.exit(1)
      }
      // Network failure or transient 5xx — assume the saved credential is
      // still good (it was valid the last time we wrote it). Print enough
      // info that the user can see what's saved and decide whether to trust
      // it. We still surface the underlying reason so this doesn't look like
      // a silent success.
      const reason = networkErr
        ? `network error (${(networkErr as { message?: string }).message ?? "unreachable"})`
        : `transient server status ${status}`
      console.log(
        `Saved credential for ${existing.username}${existing.isAdmin ? " (admin)" : ""} at ${existing.apiUrl}  (could not validate — ${reason})`,
      )
      console.log(`  Dashboard: ${existing.apiUrl}/dashboard  (or: pond dashboard)`)
      return
    }

    if (!username) {
      console.error("--username is required")
      process.exit(1)
    }

    // No saved credential AND no --token. Need to create a user via admin
    // bootstrap. Use admin-token if given, otherwise POND_HOST_TOKEN.
    const authToken = adminToken || process.env.POND_HOST_TOKEN || ""
    if (!authToken) {
      console.error(
        `Need a token to attach. Three paths forward:
  1. If you already deployed anonymously: \`pond signup <username>\` — creates an account on the control plane and claims that deploy.
  2. Existing token: \`pond login --token <token> --username <name>\` (or --api <self-hosted-url>).
  3. Self-hosted bootstrap: set POND_HOST_TOKEN env var, or pass --admin-token <token>.`,
      )
      process.exit(1)
    }

    const res = await fetch(`${apiUrl}/api/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ username }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.error(`User create failed: ${res.status} ${text}`)
      process.exit(1)
    }

    const created = (await res.json()) as {
      userId: string
      username: string
      isAdmin: boolean
      token: string
    }
    const saved = saveCredentials({
      apiUrl,
      username: created.username,
      token: created.token,
      isAdmin: created.isAdmin,
    })
    console.log(`Created user ${saved.username}${saved.isAdmin ? " (admin)" : ""} at ${saved.apiUrl}`)
    console.log(`Token saved to ~/.pond/credentials.json (mode 0600).`)
    console.log(`Dashboard: ${saved.apiUrl}/dashboard  (or: pond dashboard)`)
  },
})
