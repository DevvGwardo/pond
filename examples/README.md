# Pond examples

Small, runnable capsules. Each is a complete pond app — copy one, then:

```bash
cd examples/<name>
pond dev          # http://localhost:3000
```

Or deploy it:

```bash
pond deploy       # anonymous hosted deploy on https://pond.run
```

| Example                    | Shows                                                                   |
| -------------------------- | ----------------------------------------------------------------------- |
| [`todo`](./todo)           | Per-user ownership with the `requireUser` / `requireOwner` auth helpers |
| [`guestbook`](./guestbook) | A public app with `count()` aggregates and `offset()` pagination        |

See [`docs/capsule-spec.md`](../docs/capsule-spec.md) for the full capsule API.
