import { assert, describe, it } from "@effect/vitest"
import { Effect, type Layer, References, type Scope } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { NoteId } from "../../domain/Note.ts"
import { NotesRpcs } from "../../rpc.ts"
import { NotesRpcHandlers } from "./rpc.ts"

// `RpcTest.makeClient` runs the real encode/decode round trip against the
// handlers in-process: no Worker, no port, no Cloudflare account.
//
// R is pinned to exactly what NotesRpcHandlers supplies rather than left
// generic, so an unprovided requirement is a compile error here.
type Handlers = Layer.Success<typeof NotesRpcHandlers>

const run = <A, E>(effect: Effect.Effect<A, E, Handlers | Scope.Scope>) =>
  effect.pipe(
    Effect.provide(NotesRpcHandlers),
    // Keep the output to the assertions; raise this to see app logs.
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.scoped
  )

describe("notes rpc", () => {
  it.effect("creates then lists a note", () =>
    run(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(NotesRpcs)
      const created = yield* client.create({ title: "first", body: "hello" })
      assert.strictEqual(created.title, "first")

      const listed = yield* client.list()
      assert.strictEqual(listed.length, 1)
      assert.strictEqual(listed[0]?.id, created.id)
    })))

  it.effect("fails with NoteNotFound for an unknown id", () =>
    run(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(NotesRpcs)
      const error = yield* Effect.flip(client.getById({ id: NoteId.make("nope") }))
      assert.strictEqual(error._tag, "NoteNotFound")
    })))
})
