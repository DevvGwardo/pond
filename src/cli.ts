import { defineCommand, runMain } from "citty";
import { newCommand } from "./commands/new.ts";
import { devCommand } from "./commands/dev.ts";
import { deployCommand } from "./commands/deploy.ts";

const main = defineCommand({
  meta: {
    name: "pond",
    description: "Agent-native CLI and runtime for building small full-stack TypeScript apps",
  },
  subCommands: {
    new: newCommand,
    dev: devCommand,
    deploy: deployCommand,
  },
});

export { runMain, main };

// Self-run when executed directly
const scriptPath = process.argv[1]?.replace(/\.(js|ts)$/, "");
const thisPath = import.meta.url.replace(/^file:\/\//, "").replace(/\.(js|ts)$/, "");
if (scriptPath && thisPath.endsWith(scriptPath)) {
  runMain(main);
}
