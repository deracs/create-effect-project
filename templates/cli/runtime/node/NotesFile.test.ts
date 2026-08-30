import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, References } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NoteId } from "./domain/Note.ts"
import * as NotesFile from "./NotesFile.ts"
import { Notes } from "./server/Notes.ts"

const dir = mkdtempSync(join(tmpdir(), "notes-"))
const file = join(dir, "notes.json")

// Every `run` builds the layer from scratch, which is exactly what a second
// invocation of the CLI does. `layerMemory` would pass the first assertion in
// each test and fail the ones that span two runs.
const TestLayer = NotesFile.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ NOTES_FILE: file })))
)

const run = <A, E>(effect: Effect.Effect<A, E, Notes>) =>
  effect.pipe(
    Effect.provide(TestLayer),
    // Keep the output to the assertions; raise this to see app logs.
    Effect.provideService(References.MinimumLogLevel, "None")
  )

describe("the file-backed notes store", () => {
  it.effect("starts empty when the file does not exist yet", () =>
    run(Effect.gen(function*() {
      const notes = yield* Notes
      assert.deepStrictEqual([...yield* notes.list], [])
    })))

  it.effect("remembers a note written by an earlier run", () =>
    Effect.gen(function*() {
      const created = yield* run(Effect.flatMap(
        Notes,
        (notes) => notes.create({ title: "Buy milk", body: "2 litres" })
      ))

      // A different instance of the service, reading the same file.
      const listed = yield* run(Effect.flatMap(Notes, (notes) => notes.list))
      assert.strictEqual(listed.length, 1)
      assert.strictEqual(listed[0]?.id, created.id)
      assert.strictEqual(listed[0]?.title, "Buy milk")
    }))

  it.effect("keeps ids unique as notes accumulate", () =>
    Effect.gen(function*() {
      const second = yield* run(Effect.flatMap(
        Notes,
        (notes) => notes.create({ title: "Call Ada", body: "" })
      ))
      const listed = yield* run(Effect.flatMap(Notes, (notes) => notes.list))
      assert.strictEqual(listed.length, 2)
      assert.strictEqual(new Set(listed.map((note) => note.id)).size, 2)
      assert.strictEqual(second.id, NoteId.make("2"))
    }))

  it.effect("fails with NoteNotFound for an unknown id", () =>
    run(Effect.gen(function*() {
      const notes = yield* Notes
      const error = yield* Effect.flip(notes.getById(NoteId.make("nope")))
      assert.strictEqual(error._tag, "NoteNotFound")
    })))
})

process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
