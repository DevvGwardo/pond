# todo

A per-user todo list demonstrating pond's authorization helpers.

```bash
pond dev
```

Each row carries an `owner` column. `requireUser(ctx)` returns the signed-in
user's id (or throws for a guest); `requireOwner(ctx, "todos", id)` loads a row
and asserts the caller owns it (returning "not found" otherwise — the same answer
for "missing" and "not yours", so it leaks nothing).

### Endpoints

| Call         | Route                                                 |
| ------------ | ----------------------------------------------------- |
| `list`       | `GET /api/query/list`                                 |
| `count`      | `GET /api/query/count`                                |
| `add(text)`  | `POST /api/mutation/add` with `{"args":["buy milk"]}` |
| `toggle(id)` | `POST /api/mutation/toggle` with `{"args":["<id>"]}`  |
| `remove(id)` | `POST /api/mutation/remove` with `{"args":["<id>"]}`  |

A signed-in session (`pond_session` cookie) is required — guests get an
`unauthorized` error from `requireUser`.
