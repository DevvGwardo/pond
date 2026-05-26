import { defineCommand, runMain } from "citty";
import { newCommand } from "./commands/new.js";
import { devCommand } from "./commands/dev.js";
import { deployCommand } from "./commands/deploy.js";
import { dbCommand } from "./commands/db.js";
import { logsCommand } from "./commands/logs.js";
import { inspectCommand } from "./commands/inspect.js";
import { authCommand } from "./commands/auth.js";

const main = defineCommand({
  meta: {
    name: "pond",
    description: "Agent-native CLI and runtime for building small full-stack TypeScript apps",
  },
  subCommands: {
    new: newCommand,
    dev: devCommand,
    deploy: deployCommand,
    db: dbCommand,
    logs: logsCommand,
    inspect: inspectCommand,
    auth: authCommand,
  },
});

export { runMain, main };

// Self-run when executed directly
const scriptPath = process.argv[1]?.replace(/\.(js|ts)$/, "");
const thisPath = import.meta.url.replace(/^file:\/\//, "").replace(/\.(js|ts)$/, "");
if (scriptPath && thisPath.endsWith(scriptPath)) {
  runMain(main);
}
