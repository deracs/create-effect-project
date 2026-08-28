/**
 * Client entrypoint — exercises the API with the generated typed client.
 *
 * Point it at the deployed Worker, or at `{{runCmd}} dev`:
 *
 *   API_URL=https://... {{runCmd}} client
 */
import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { ApiClient } from "./client/ApiClient.ts"
import { NoteId } from "./domain/Note.ts"

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
  // Worker returns as a 404.
  const missing = yield* client.notes.getById({ params: { id: NoteId.make("nope") } }).pipe(
    Effect.catchTag("NoteNotFound", () => Effect.succeed("NoteNotFound (404) as expected"))
  )
  yield* Effect.logInfo("getById?id=nope", missing)
}).pipe(Effect.provide(ApiClient.layer))

program.pipe(BunRuntime.runMain)
