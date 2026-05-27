import { defineCommand } from "citty"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const uninstallCommand = defineCommand({
  meta: {
    name: "uninstall",
    description: "Wipe local pond state and print the command to remove the CLI",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Skip the dry-run preview and actually delete state",
      default: false,
    },
  },
  async run({ args }) {
    const pondDir = path.join(os.homedir(), ".pond")
    const hasPondDir = fs.existsSync(pondDir)
    const yes = Boolean((args as { yes?: boolean }).yes)
    const isWin = process.platform === "win32"
    const removeCmd = isWin ? `Remove-Item -Recurse -Force "${pondDir}"` : `rm -rf ${JSON.stringify(pondDir)}`

    if (!hasPondDir) {
      console.log()
      console.log(`  No ${pondDir} found — nothing for \`pond uninstall\` to clean up.`)
      console.log()
      console.log("  To finish removing pond, run these yourself:")
      console.log()
      console.log("    npm uninstall -g pondsh")
      console.log("    npm cache clean --force          # only if you used `npx pondsh`")
      console.log()
      console.log("  (Re-running with --yes won't change anything — there's nothing to delete.)")
      console.log()
      return
    }

    console.log("\n  Pond uninstall plan:")
    console.log(`    1. Remove ${pondDir}`)
    console.log(`       (saved credentials + control-plane state — recoverable only if you backed it up)`)
    console.log(`    2. Run \`npm uninstall -g pondsh\` yourself. Pond cannot remove itself from npm.`)
    console.log(`    3. (Optional) If you ever used \`npx pondsh\`, clear the cache: \`npm cache clean --force\`.`)
    console.log(`    4. (Optional) Delete any scaffolded capsule directories you no longer want.`)
    console.log()

    if (!yes) {
      console.log("  Dry run. Re-run with --yes to execute step 1.")
      console.log(`  Or remove manually: ${removeCmd}`)
      console.log()
      return
    }

    fs.rmSync(pondDir, { recursive: true, force: true })
    console.log(`  Removed ${pondDir}.`)
    console.log()
    console.log("  Now run this in your terminal to remove the CLI itself:")
    console.log()
    console.log("    npm uninstall -g pondsh")
    console.log()
  },
})
