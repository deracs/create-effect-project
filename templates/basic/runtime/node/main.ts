/**
 * Program entrypoint.
 *
 * A service (`src/Users.ts`) supplied by an in-memory layer, a typed error
 * (`UserNotFound`), and a program that handles it. No server — this runs,
 * logs, and exits.
 *
 *   {{runCmd}} dev     # watch mode
 *   {{runCmd}} start   # once
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { UserId } from "./domain/User.ts"
import * as Observability from "./observability.ts"
import { Users } from "./Users.ts"

const program = Effect.gen(function*() {
  // Yielding the class asks for the service. Nothing here knows which layer
  // will supply it.
  const users = yield* Users

  const created = yield* users.create({ name: "Ada", email: "ada@example.com" })
  yield* Effect.logInfo("created", created)

  const fetched = yield* users.getById(created.id)
  yield* Effect.logInfo("getById", fetched)

  // `list` is a value rather than a method, so there are no parentheses.
  const all = yield* users.list
  yield* Effect.logInfo("list", all)

  // `UserNotFound` is in the program's error type, so this must be handled:
  // delete the `catchTag` and it is a compile error, not a surprise at 3am.
  const missing = yield* users.getById(UserId.make("nope")).pipe(
    Effect.catchTag("UserNotFound", (error) => Effect.succeed(`no user ${error.id} — handled`))
  )
  yield* Effect.logInfo("getById?id=nope", missing)
}).pipe(
  Effect.withSpan("main"),
  Effect.provide(Layer.mergeAll(Users.layerMemory, Observability.layer("{{name}}")))
)

program.pipe(NodeRuntime.runMain)
