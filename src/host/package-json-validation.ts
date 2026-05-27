// Shared validator for package.json contents on both the upload side (IDE
// PUT, bulk source POST/PUT) and the download side (`pond fork`). npm runs
// these scripts automatically on `npm install`, which makes any of them an
// RCE primitive against anyone who later installs the package — including
// the original author re-cloning their own deploy onto a new machine.
//
// The upload side refuses to accept these scripts AT ALL (no opt-in flag —
// there's no legitimate reason a pond capsule needs them; the bundle is
// built by esbuild, not by an install step). The download side keeps its
// `--allow-scripts` opt-in for the corner case of someone forking an
// established public deploy they explicitly trust.
export const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "postprepare"] as const

export interface PackageJsonLifecycleResult {
  ok: boolean
  offending: string[]
}

// Parse `text` as package.json and report which lifecycle scripts it
// defines. `ok` is true if either it isn't valid JSON (caller handles) or
// no lifecycle scripts are present. JSON parse failure is treated as
// `ok: true` because the upload-path callers want to surface their own
// "invalid package.json" error rather than conflating it with the security
// rejection.
export function findPackageJsonLifecycleScripts(text: string): PackageJsonLifecycleResult {
  let parsed: { scripts?: Record<string, unknown> } | null = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: true, offending: [] }
  }
  if (!parsed?.scripts || typeof parsed.scripts !== "object") {
    return { ok: true, offending: [] }
  }
  const offending = LIFECYCLE_SCRIPTS.filter((s) => typeof parsed!.scripts![s] === "string")
  return { ok: offending.length === 0, offending: [...offending] }
}
