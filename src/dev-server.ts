import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildClient } from "./bundler.js";
import { createRuntime } from "./runtime.js";

export async function startDevServer(port: number): Promise<void> {
  const cwd = process.cwd();
  const serverFile = path.join(cwd, "server", "index.ts");
  const clientFile = path.join(cwd, "client", "index.tsx");

  if (!fs.existsSync(serverFile)) {
    console.error("No server/index.ts found. Run `npx pond new <name>` first.");
    process.exit(1);
  }

  const app = new Hono();

  app.use("*", cors());

  // Build and serve client
  const clientBundle = await buildClient(clientFile);
  app.get("/", (c) => c.html(clientBundle));
  app.get("/assets/*", (c) => {
    // Serve static assets
    return c.text("", 404);
  });

  // Create runtime for server capsule
  const runtime = await createRuntime(serverFile, cwd);
  runtime.mount(app);

  console.log(`\n  pond dev server running at http://localhost:${port}\n`);

  serve({ fetch: app.fetch, port });
}
