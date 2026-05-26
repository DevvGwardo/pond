import { defineCommand } from "citty";

export const deployCommand = defineCommand({
  meta: {
    name: "deploy",
    description: "Deploy the capsule",
  },
  async run() {
    console.log("Deploy coming soon.");
  },
});
