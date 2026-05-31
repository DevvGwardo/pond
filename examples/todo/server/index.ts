import { capsule, query, mutation, string, boolean, table, requireUser, requireOwner } from "pond/server"

// A per-user todo list. Authorization is the handler's job (capsule-spec §1.5):
// every read filters by the caller, and every write re-checks ownership. The
// requireUser / requireOwner helpers fold that boilerplate.
export default capsule({
  schema: {
    todos: table({
      owner: string(), // the user id that owns this row
      text: string(),
      done: boolean(),
    }),
  },
  queries: {
    // Only the signed-in caller's todos, newest first.
    list: query((ctx) => ctx.db.todos.where("owner", requireUser(ctx)).orderBy("createdAt", "desc").all()),
    // How many the caller has.
    count: query((ctx) => ctx.db.todos.where("owner", requireUser(ctx)).count()),
  },
  mutations: {
    add: mutation((ctx, text: string) => {
      const owner = requireUser(ctx)
      return ctx.db.todos.insert({ owner, text, done: false })
    }),
    toggle: mutation((ctx, id: string) => {
      const row = requireOwner(ctx, "todos", id) // throws "not found" if not yours
      return ctx.db.todos.update(id, { done: !row.done })
    }),
    remove: mutation((ctx, id: string) => {
      requireOwner(ctx, "todos", id)
      ctx.db.todos.delete(id)
      return { ok: true }
    }),
  },
})
