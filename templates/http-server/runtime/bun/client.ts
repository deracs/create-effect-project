/**
 * Client entrypoint — exercises the running server with the generated client.
 *
 *   {{runCmd}} dev      # in one terminal
 *   {{runCmd}} client   # in another
 */
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ApiClient } from "./client/ApiClient.ts"
import { NoteId } from "./domain/Note.ts"
import * as Observability from "./observability.ts"

const program = Effect.gen(function*() {
  const client = yield* ApiClient

  // `system` is a top level group, so its endpoints sit at the root.
  yield* client.health()
  yield* Effect.logInfo("health: ok")

  const created = yield* client.notes.create({ payload: { title: "first", body: "hello" } })
  yield* Effect.logInfo("created", created)

  const fetched = yield* client.notes.getById({ params: { id: created.id } })
  yield* Effect.logInfo("getById", fetched)

  const all = yield* client.notes.list()
  yield* Effect.logInfo("list", all)

  // Errors are typed too: an unknown id fails with `NoteNotFound`, which the
  // server returns as a 404.
  const missing = yield* client.notes.getById({ params: { id: NoteId.make("nope") } }).pipe(
    Effect.catchTag("NoteNotFound", () => Effect.succeed("NoteNotFound (404) as expected"))
  )
  yield* Effect.logInfo("getById?id=nope", missing)
}).pipe(
  Effect.withSpan("client-demo"),
  Effect.provide(Layer.mergeAll(ApiClient.layer, Observability.layer("notes-client")))
)

program.pipe(BunRuntime.runMain)
