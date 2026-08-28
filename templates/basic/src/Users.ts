import { Context, Effect, Layer } from "effect"
import { User, type UserCreate, UserId, UserNotFound } from "./domain/User.ts"

/**
 * A service: an interface, a tag, and a layer that supplies it.
 *
 * The interface is what callers see; `layerMemory` is one implementation. Swap
 * it for a database-backed layer and nothing in `main.ts` changes.
 */
export class Users extends Context.Service<Users, {
  readonly list: Effect.Effect<ReadonlyArray<User>>
  getById(id: UserId): Effect.Effect<User, UserNotFound>
  create(input: typeof UserCreate.Type): Effect.Effect<User>
}>()("app/Users") {
  static readonly layerMemory = Layer.sync(Users, () => {
    const store = new Map<UserId, User>()
    let next = 1

    // `Effect.fn` names the span each call creates, so with `--otel` these show
    // up as `Users.getById` / `Users.create` in the trace.
    const getById = Effect.fn("Users.getById")(function*(id: UserId) {
      yield* Effect.annotateCurrentSpan({ id })
      const found = store.get(id)
      if (found === undefined) {
        // The failure is returned, not thrown, so it lands in the error channel
        // and every caller has to deal with it.
        return yield* new UserNotFound({ id })
      }
      return found
    })

    const create = Effect.fn("Users.create")(function*(input: typeof UserCreate.Type) {
      // `UserId.make` is the branded constructor. Never reach for `as UserId`:
      // the cast would compile even for a value the brand rejects.
      const user = new User({ id: UserId.make(String(next++)), name: input.name, email: input.email })
      store.set(user.id, user)
      yield* Effect.annotateCurrentSpan({ id: user.id })
      return user
    })

    return Users.of({
      // `list` is a value, not a method, so it is named with `withSpan` rather
      // than `Effect.fn`.
      list: Effect.sync(() => [...store.values()]).pipe(Effect.withSpan("Users.list")),
      getById,
      create
    })
  })
}
