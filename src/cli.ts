import { defineCommand, runMain } from "citty"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import { newCommand } from "./commands/new.js"
import { devCommand } from "./commands/dev.js"
import { deployCommand } from "./commands/deploy.js"
import { claimCommand } from "./commands/claim.js"
import { adminCommand } from "./commands/admin.js"
import { startCommand } from "./commands/start.js"
import { hostCommand } from "./commands/host.js"
import { dbCommand } from "./commands/db.js"
import { logsCommand } from "./commands/logs.js"
import { inspectCommand } from "./commands/inspect.js"
import { authCommand } from "./commands/auth.js"
import { loginCommand } from "./commands/login.js"
import { userCommand } from "./commands/user.js"
import { envCommand } from "./commands/env.js"
import { domainsCommand } from "./commands/domains.js"
import { tokenCommand } from "./commands/token.js"
import { forkCommand } from "./commands/fork.js"
import { signupCommand } from "./commands/signup.js"
import { dashboardCommand } from "./commands/dashboard.js"
import { uninstallCommand } from "./commands/uninstall.js"

const main = defineCommand({
  meta: {
    name: "pond",
    description: "Agent-native CLI and runtime for building small full-stack TypeScript apps",
  },
  subCommands: {
    new: newCommand,
    dev: devCommand,
    deploy: deployCommand,
    claim: claimCommand,
    admin: adminCommand,
    signup: signupCommand,
    start: startCommand,
    host: hostCommand,
    db: dbCommand,
    logs: logsCommand,
    inspect: inspectCommand,
    auth: authCommand,
    login: loginCommand,
    user: userCommand,
    env: envCommand,
    domains: domainsCommand,
    token: tokenCommand,
    fork: forkCommand,
    dashboard: dashboardCommand,
    uninstall: uninstallCommand,
  },
})

export { runMain, main }

// Self-run when executed directly
const scriptPath = process.argv[1]
const thisPath = fileURLToPath(import.meta.url)
if (scriptPath && path.resolve(thisPath) === path.resolve(scriptPath)) {
  runMain(main)
}
