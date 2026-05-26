import { Hono } from "hono";
import Database from "better-sqlite3";
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { CapsuleDefinition, CapsuleContext } from "./server/index.js";

interface ServerModule {
  default: CapsuleDefinition;
}

export async function createRuntime(serverFile: string, cwd: string): Promise<{ mount: (app: any) => void; db: any; def: CapsuleDefinition }> {
  // Transpile the server file to JS so we can import it
  const result = await esbuild.build({
    entryPoints: [serverFile],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2020",
    platform: "node",
    packages: "external",
    alias: {
      "pond/server": path.resolve(import.meta.dirname, "../src/server/index.ts"),
    },
  });

  const js = result.outputFiles[0].text;

  // Write temp file and import it
  const tmpFile = path.join(cwd, ".pond", "server.mjs");
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, js);

  const mod: ServerModule = await import(tmpFile);
  const def = mod.default;

  // Set up SQLite
  const dbPath = path.join(cwd, ".pond", "data.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // Enable WAL mode
  db.pragma("journal_mode = WAL");

  // Create tables from schema
  db.exec("CREATE TABLE IF NOT EXISTS _pond_migrations (name TEXT PRIMARY KEY)");

  for (const [tableName, columns] of Object.entries(def.schema)) {
    const exists = db
      .prepare("SELECT name FROM _pond_migrations WHERE name = ?")
      .get(`table_${tableName}`);

    if (!exists) {
      const colDefs = Object.entries(columns).map(
        ([col, type]) => `${col} ${type._sqlType}`
      );
      colDefs.push("id TEXT PRIMARY KEY");
      colDefs.push("createdAt TEXT DEFAULT (datetime('now'))");
      colDefs.push("updatedAt TEXT DEFAULT (datetime('now'))");

      db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs.join(", ")})`);
      db.prepare("INSERT INTO _pond_migrations (name) VALUES (?)").run(
        `table_${tableName}`
      );
    }
  }

  // Build the context that gets passed to handlers
  const ctx: CapsuleContext = {
    db: buildDbProxy(db),
    auth: { isGuest: true, userId: "guest", displayName: "Guest" },
    env: loadEnv(cwd),
    log: {
      info: (msg: string, data?: any) =>
        console.log(`[pond] ${msg}`, data ?? ""),
      error: (msg: string, data?: any) =>
        console.error(`[pond] ${msg}`, data ?? ""),
    },
  };

  function mount(app: Hono) {
    // Register query endpoints
    for (const [name, handler] of Object.entries(def.queries)) {
      app.get(`/api/query/${name}`, async (c) => {
        const result = await handler(ctx);
        return c.json(result);
      });
    }

    // Register mutation endpoints
    for (const [name, handler] of Object.entries(def.mutations)) {
      app.post(`/api/mutation/${name}`, async (c) => {
        const body = await c.req.json();
        const args = body.args ?? [];
        const result = await handler(ctx, ...args);
        return c.json(result);
      });
    }

    // Register custom endpoints
    for (const [name, handler] of Object.entries(def.endpoints ?? {})) {
      const ep = handler as any;
      const method = ep._method?.toLowerCase() ?? "get";
      const epPath = ep._path ?? `/api/${name}`;

      app[method as "get" | "post"](epPath, async (c) => {
        const result = await ep.handler(ctx, {
          headers: c.req.raw.headers,
          query: c.req.query(),
          json: async <T>() => (await c.req.json()) as T,
          text: async () => await c.req.text(),
          bytes: async () => await c.req.arrayBuffer(),
        });
        return c.newResponse(result.body, result.status, result.headers);
      });
    }
  }

  return { mount, db, def };
}

function buildDbProxy(db: Database.Database): CapsuleContext["db"] {
  return new Proxy({} as any, {
    get(_target, tableName: string) {
      return {
        where(column: string, value: string) {
          return {
            orderBy(_col: string, _dir: string) {
              return {
                all() {
                  return db
                    .prepare(`SELECT * FROM ${tableName} WHERE ${column} = ?`)
                    .all(value);
                },
              };
            },
            all() {
              return db
                .prepare(`SELECT * FROM ${tableName} WHERE ${column} = ?`)
                .all(value);
            },
          };
        },
        orderBy(_col: string, _dir: string) {
          return {
            all() {
              return db.prepare(`SELECT * FROM ${tableName}`).all();
            },
          };
        },
        all() {
          return db.prepare(`SELECT * FROM ${tableName}`).all();
        },
        get(id: string) {
          return db
            .prepare(`SELECT * FROM ${tableName} WHERE id = ?`)
            .get(id);
        },
        insert(data: Record<string, any>) {
          const id = crypto.randomUUID();
          const keys = Object.keys(data);
          const values = keys.map((k) => data[k]);
          db.prepare(
            `INSERT INTO ${tableName} (id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`
          ).run(id, ...values);
          return db
            .prepare(`SELECT * FROM ${tableName} WHERE id = ?`)
            .get(id);
        },
        update(id: string, data: Record<string, any>) {
          const sets = Object.keys(data)
            .map((k) => `${k} = ?`)
            .join(", ");
          db.prepare(
            `UPDATE ${tableName} SET ${sets}, updatedAt = datetime('now') WHERE id = ?`
          ).run(...Object.values(data), id);
          return db
            .prepare(`SELECT * FROM ${tableName} WHERE id = ?`)
            .get(id);
        },
        delete(id: string) {
          db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
        },
      };
    },
  });
}

function loadEnv(cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  const envFile = path.join(cwd, ".env.pond.server");
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  return env;
}
