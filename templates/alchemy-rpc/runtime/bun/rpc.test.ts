import { expect, test } from "bun:test"
import { Effect, type Layer, References, type Scope } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { NoteId } from "../../domain/Note.ts"
import { NotesRpcs } from "../../rpc.ts"
import { NotesRpcHandlers } from "./rpc.ts"

// `RpcTest.makeClient` runs the real encode/decode round trip against the
// handlers in-process: no Worker, no port, no Cloudflare account.
//
// `runPromise` demands a fully-provided effect, so R is pinned to exactly what
// NotesRpcHandlers supplies rather than left generic.
type Handlers = Layer.Success<typeof NotesRpcHandlers>

const run = <A, E>(effect: Effect.Effect<A, E, Handlers | Scope.Scope>) =>
  effect.pipe(
    Effect.provide(NotesRpcHandlers),
    // Keep the output to the assertions; raise this to see app logs.
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.scoped,
    Effect.runPromise
  )

test("creates then lists a note", () =>
  run(Effect.gen(function*() {
    const client = yield* RpcTest.makeClient(NotesRpcs)
    const created = yield* client.create({ title: "first", body: "hello" })
    expect(created.title).toBe("first")

    const listed = yield* client.list()
    expect(listed.length).toBe(1)
    expect(listed[0]?.id).toBe(created.id)
  })))

test("fails with NoteNotFound for an unknown id", () =>
  run(Effect.gen(function*() {
    const client = yield* RpcTest.makeClient(NotesRpcs)
    const error = yield* Effect.flip(client.getById({ id: NoteId.make("nope") }))
    expect(error._tag).toBe("NoteNotFound")
  })))
