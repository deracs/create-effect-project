import { expect, test } from "bun:test"
import type { Scope } from "effect"
import { Effect, Layer, References } from "effect"
import { HttpServer } from "effect/unstable/http"
import { HttpApiTest } from "effect/unstable/httpapi"
import { Api } from "../../api/Api.ts"
import { NoteId } from "../../domain/Note.ts"
import { Notes } from "../Notes.ts"
import { NotesApiHandlersNoDeps } from "./http.ts"

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
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.runPromise
  )

test("creates then lists a note", () =>
  run(TestLayer, Effect.gen(function*() {
    const client = yield* makeClient
    const created = yield* client.notes.create({ payload: { title: "first", body: "hello" } })
    expect(created.title).toBe("first")

    const listed = yield* client.notes.list()
    expect(listed.length).toBe(1)
    expect(listed[0]?.id).toBe(created.id)
  })))

test("fails with NoteNotFound for an unknown id", () =>
  run(TestLayer, Effect.gen(function*() {
    const client = yield* makeClient
    const error = yield* Effect.flip(
      client.notes.getById({ params: { id: NoteId.make("nope") } })
    )
    expect(error._tag).toBe("NoteNotFound")
  })))
