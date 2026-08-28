import { assert, describe, it } from "@effect/vitest"
import type { Scope } from "effect"
import { Effect, Layer, References } from "effect"
import { HttpServer } from "effect/unstable/http"
import { HttpApiTest } from "effect/unstable/httpapi"
import { Api } from "../../api/Api.ts"
import { NoteId } from "../../domain/Note.ts"
import { Notes } from "../Notes.ts"
import { NotesApiHandlersNoDeps } from "./http.ts"

// Handlers wired to the in-memory Notes, so the whole HTTP pipeline runs
// without a server: same encoding, routing and decoding as production.
const TestLayer = Layer.mergeAll(
  NotesApiHandlersNoDeps.pipe(Layer.provide(Notes.layerMemory)),
  HttpServer.layerServices
)

const makeClient = HttpApiTest.groups(Api, ["notes"])

const run = <A, E, R>(layer: Layer.Layer<R>, effect: Effect.Effect<A, E, R | Scope.Scope>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(layer),
    // Keep the test output to the assertions; raise this to see app logs.
    Effect.provideService(References.MinimumLogLevel, "None")
  )

describe("notes api", () => {
  it.effect("creates then lists a note", () =>
    run(TestLayer, Effect.gen(function*() {
      const client = yield* makeClient
      const created = yield* client.notes.create({ payload: { title: "first", body: "hello" } })
      assert.strictEqual(created.title, "first")

      const listed = yield* client.notes.list()
      assert.strictEqual(listed.length, 1)
      assert.strictEqual(listed[0]?.id, created.id)
    })))

  it.effect("fails with NoteNotFound for an unknown id", () =>
    run(TestLayer, Effect.gen(function*() {
      const client = yield* makeClient
      const error = yield* Effect.flip(
        client.notes.getById({ params: { id: NoteId.make("nope") } })
      )
      assert.strictEqual(error._tag, "NoteNotFound")
    })))
})
