# guestbook

A public guestbook demonstrating `count()` aggregates and `offset()` pagination.

```bash
pond dev
```

### Endpoints

| Call                  | Route                                                   |
| --------------------- | ------------------------------------------------------- |
| `page(offset)`        | `POST /api/query/page` with `{"args":[0]}`              |
| `total`               | `GET /api/query/total`                                  |
| `sign(name, message)` | `POST /api/mutation/sign` with `{"args":["Ada","hi!"]}` |

`page` returns 20 entries newest-first; pass an `offset` of 20, 40, … to page
through. `total` returns the row count for a "N signatures" badge.
