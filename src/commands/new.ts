import { defineCommand } from "citty"
import { copyTemplate } from "../template.js"

export const newCommand = defineCommand({
  meta: {
    name: "new",
    description: "Create a new pond capsule",
  },
  args: {
    name: {
      type: "positional",
      description: "Name of the capsule directory",
      required: true,
    },
    template: {
      type: "string",
      description: "Template to use (default: todo)",
      default: "todo",
    },
    "no-git": {
      type: "boolean",
      description: "Skip git initialization",
      default: false,
    },
  },
  async run({ args }) {
    await copyTemplate(args.name, args.template, !args["no-git"])
    console.log(`\n  Created ${args.name}/\n`)
    console.log(`  Next steps:`)
    console.log(`    cd ${args.name}`)
    console.log(`    npm install`)
    console.log(`    npm run dev\n`)
  },
})
