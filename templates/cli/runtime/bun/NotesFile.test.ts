import { BunServices } from "@effect/platform-bun"
import { expect, test } from "bun:test"
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
  Layer.provide(BunServices.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ NOTES_FILE: file })))
)

const run = <A, E>(effect: Effect.Effect<A, E, Notes>) =>
  effect.pipe(
    Effect.provide(TestLayer),
    // Keep the output to the assertions; raise this to see app logs.
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.runPromise
  )

test("starts empty when the file does not exist yet", async () => {
  const listed = await run(Effect.flatMap(Notes, (notes) => notes.list))
  expect([...listed]).toEqual([])
})

test("remembers a note written by an earlier run", async () => {
  const created = await run(Effect.flatMap(
    Notes,
    (notes) => notes.create({ title: "Buy milk", body: "2 litres" })
  ))

  // A different instance of the service, reading the same file.
  const listed = await run(Effect.flatMap(Notes, (notes) => notes.list))
  expect(listed.length).toBe(1)
  expect(listed[0]?.id).toBe(created.id)
  expect(listed[0]?.title).toBe("Buy milk")
})

test("keeps ids unique as notes accumulate", async () => {
  const second = await run(Effect.flatMap(
    Notes,
    (notes) => notes.create({ title: "Call Ada", body: "" })
  ))
  const listed = await run(Effect.flatMap(Notes, (notes) => notes.list))
  expect(listed.length).toBe(2)
  expect(new Set(listed.map((note) => note.id)).size).toBe(2)
  expect(second.id).toBe(NoteId.make("2"))
})

test("fails with NoteNotFound for an unknown id", async () => {
  const error = await run(Effect.flip(
    Effect.flatMap(Notes, (notes) => notes.getById(NoteId.make("nope")))
  ))
  expect(error._tag).toBe("NoteNotFound")
})

process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
