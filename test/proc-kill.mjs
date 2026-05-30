import { spawnSync } from "node:child_process"

const isWindows = process.platform === "win32"

// Stop a spawned host process and ALL its descendants, resolving once it has
// exited. The pond host forks a worker child per deploy; those workers hold the
// deploy's bundle and better-sqlite3 data.db open.
//
// POSIX: SIGINT reaches the host's signal handler, which gracefully stops every
// worker before exiting (with SIGKILL as a fallback). Clean.
//
// Windows: there are no real POSIX signals — child.kill("SIGINT") hard-terminates
// ONLY the host process, so its worker children are orphaned and keep running,
// holding data.db locked. The test's subsequent rmdir then fails with EBUSY no
// matter how long it retries (a live process, not a lagging handle). So on Windows
// we taskkill the whole process TREE (/T) forcefully (/F), reaping the workers too.
export async function stopProc(proc, graceMs = 4000) {
  if (!proc || proc.pid == null || proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise((resolve) => proc.once("exit", () => resolve()))
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    proc.kill("SIGINT")
    const t = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL")
    }, graceMs)
    t.unref()
  }
  // Never hang the suite if the "exit" event is somehow missed.
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs + 2000).unref())])
}
