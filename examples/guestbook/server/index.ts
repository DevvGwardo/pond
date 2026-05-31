import { capsule, query, mutation, string, table } from "pond/server"

// A public guestbook. Anyone can sign it; entries are listed newest-first with
// offset pagination, and a count() aggregate powers a "N signatures" badge.
export default capsule({
  schema: {
    entries: table({
      name: string(),
      message: string(),
    }),
  },
  queries: {
    // One page (20) of entries, newest first. `offset` is the row to start at.
    page: query((ctx, offset: number) =>
      ctx.db.entries
        .orderBy("createdAt", "desc")
        .limit(20)
        .offset(typeof offset === "number" && offset > 0 ? offset : 0)
        .all(),
    ),
    total: query((ctx) => ctx.db.entries.count()),
  },
  mutations: {
    sign: mutation((ctx, name: string, message: string) => ctx.db.entries.insert({ name, message })),
  },
})
