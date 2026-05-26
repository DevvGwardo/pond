# Contributing to Pond

Thanks for taking the time. Pond is an alpha agent-native CLI and runtime — small surface, focused changes, lots of room to grow.

## Local setup

```bash
git clone https://github.com/DevvGwardo/pond.git
cd pond
npm install
npm run build      # tsc once; produces .js next to .ts
npm test           # build + node --test test/*.test.mjs
```

You need **Node 18+** (Node 22+ to exercise the `--experimental-permission` sandbox in the host tests).

## Dev loop

- `npm run dev` runs `tsc --watch` so generated `.js` is always fresh.
- The test suite (`test/host.test.mjs`) is the integration layer — it spawns real `pond host` processes against a tmpdir and exercises the API. Run `node --test test/host.test.mjs` to iterate on a single file.
- For interactive iteration on a capsule, `cd` into a scratch directory, run `node /path/to/pond/src/cli.js new mything`, then `node /path/to/pond/src/cli.js dev`.

## Adding a CLI command

CLI commands live in `src/commands/<name>.ts` and are wired in `src/cli.ts`. Each command exports a Citty `defineCommand(...)`. Conventions:

- Keep commands thin — most logic should live in a sibling module (`src/runtime.ts`, `src/host/*.ts`, etc.).
- For commands that hit the hosted control plane, read `apiUrl` and credentials with `loadCredentials()` from `src/host/credentials.ts`.
- Print human output to stdout; warnings and errors to stderr.

## Adding to the hosted control plane

`src/commands/host.ts` is the control plane Hono app. New endpoints should:

- Authenticate via `requireUser`, `requireAdmin`, or `authorizeDeployMutation` — never read the bearer token directly.
- Add an `audit(actor, action, { ... })` call for mutations.
- Be covered by a test in `test/host.test.mjs`.

`src/host/control-db.ts` is the SQLite control DB. Adding a table:

1. Add the schema to the `db.exec()` block.
2. If existing installs need to migrate, add a `PRAGMA table_info(...)` migration block.
3. Add prepared statements in the local scope.
4. Add methods to the `ControlDb` interface and the returned object.

## Tests

`test/host.test.mjs` is the single integration suite right now. It:

- Spawns the CLI as a child process against tmpdirs (no in-process state).
- Uses `pickFreePort()` to avoid port conflicts on parallel runs.
- Cleans up tmpdirs and host processes in `after()`.

For any control-plane change, add at least one happy-path and one rejection-path test in this file. For runtime/capsule changes (anything in `src/runtime.ts`), add a capsule under `buildBundleWith(...)` and exercise it through the host proxy — that's how you get full coverage including the worker fork + permission model.

## PR checklist

- [ ] `npm test` passes locally
- [ ] `tsc --noEmit` is clean (covered by `npm run build`)
- [ ] New CLI flags / endpoints / behavior are reflected in `README.md`
- [ ] Mutation endpoints have audit log writes
- [ ] Commit messages explain the _why_, not just the _what_

## Coding style

- Match the surrounding code. No semicolons, double quotes, arrow functions where it reads cleanly.
- Don't add comments that restate the code. Do add comments when behavior would surprise a reader (security trade-offs, why-not, OS-specific caveats).
- No new top-level dependencies without a clear justification.

## Security-sensitive changes

If you're touching:

- The anonymous deploy sandbox (`src/host/deploy-worker.ts`, the network shim, the `--experimental-permission` flags in `src/commands/host.ts`)
- The control-plane auth surface (`src/host/control-db.ts`, `requireUser`/`requireAdmin`)
- Tokens, claim tokens, or anything that lands on disk with secrets

…please add a regression test that demonstrates the property you're preserving (or fixing).
