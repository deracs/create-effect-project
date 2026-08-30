/**
 * A second implementation of the `Notes` service, backed by a JSON file.
 *
 * `src/server/Notes.ts` — the same file the HTTP and RPC templates use — ships
 * `layerMemory`, a `Map` that dies with the process. That is right for a server,
 * which outlives every request, and wrong for a CLI, which exits after one: `add`
 * in one invocation and `list` in the next would disagree.
 *
 * Nothing in `src/commands.ts` knows which of the two it is talking to. Swapping
 * the layer in `src/main.ts` is the entire difference — that is what a service
 * interface buys you.
 */
import { Config, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Note, type NoteCreate, NoteId, NoteNotFound } from "./domain/Note.ts"
import { Notes } from "./server/Notes.ts"

/** The file is an array of the same `Note` the rest of the app passes around. */
const Stored = Schema.Array(Note)

/** Where the notes live. Relative paths resolve against the working directory. */
export const location = Config.string("NOTES_FILE").pipe(Config.withDefault(".notes.json"))

export const layer = Layer.effect(
  Notes,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.resolve(yield* location)

    // The service says `list` and `create` cannot fail, and this implementation
    // has to honour that. An unreadable notes file is not something a caller can
    // recover from, so it becomes a defect rather than widening an error type
    // every other implementation would then have to carry.
    //
    // Which is the distinction worth taking away: `NoteNotFound` is an expected
    // outcome, so it is in the type and `src/commands.ts` must handle it. A
    // corrupt store is a bug in the world, so it is a defect and you get a stack
    // trace pointing at the file. Errors you plan for are typed; the rest crash.
    const read = Effect.gen(function*() {
      if (!(yield* fs.exists(file))) return []
      const raw = yield* fs.readFileString(file)
      return yield* Schema.decodeEffect(Stored)(JSON.parse(raw))
    }).pipe(Effect.orDie, Effect.withSpan("NotesFile.read"))

    const write = Effect.fn("NotesFile.write")(function*(notes: ReadonlyArray<Note>) {
      const encoded = yield* Schema.encodeEffect(Stored)(notes)
      yield* fs.writeFileString(file, `${JSON.stringify(encoded, null, 2)}\n`)
    }, Effect.orDie)

    const getById = Effect.fn("NotesFile.getById")(function*(id: NoteId) {
      yield* Effect.annotateCurrentSpan({ id })
      const found = (yield* read).find((note) => note.id === id)
      if (found === undefined) {
        return yield* new NoteNotFound({ id })
      }
      return found
    })

    const create = Effect.fn("NotesFile.create")(function*(input: typeof NoteCreate.Type) {
      const notes = yield* read
      // Counted from the highest id rather than the length, so ids stay unique
      // if someone deletes a line from the file by hand.
      const next = notes.reduce((max, note) => Math.max(max, Number(note.id) || 0), 0) + 1
      // `NoteId.make` is the branded constructor. Never reach for `as NoteId`:
      // the cast would compile even for a value the brand rejects.
      const note = new Note({ id: NoteId.make(String(next)), title: input.title, body: input.body })
      yield* write([...notes, note])
      yield* Effect.annotateCurrentSpan({ id: note.id })
      return note
    })

    return Notes.of({ list: read, getById, create })
  })
)
