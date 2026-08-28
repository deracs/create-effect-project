import { Context, Effect, Layer } from "effect"
import { Note, type NoteCreate, NoteId, NoteNotFound } from "../domain/Note.ts"

export class Notes extends Context.Service<Notes, {
  readonly list: Effect.Effect<ReadonlyArray<Note>>
  getById(id: NoteId): Effect.Effect<Note, NoteNotFound>
  create(input: typeof NoteCreate.Type): Effect.Effect<Note>
}>()("app/Notes") {
  static readonly layerMemory = Layer.sync(Notes, () => {
    const store = new Map<NoteId, Note>()
    let next = 1

    // `Effect.fn` names the span each call creates, so with `--otel` these show
    // up as `Notes.list` / `Notes.getById` / `Notes.create` inside the request
    // span the HTTP server opens.
    const getById = Effect.fn("Notes.getById")(function*(id: NoteId) {
      yield* Effect.annotateCurrentSpan({ id })
      const found = store.get(id)
      if (found === undefined) {
        return yield* new NoteNotFound({ id })
      }
      return found
    })

    const create = Effect.fn("Notes.create")(function*(input: typeof NoteCreate.Type) {
      // `NoteId.make` is the branded constructor. Never reach for `as NoteId`:
      // the cast would compile even for a value the brand rejects.
      const note = new Note({ id: NoteId.make(String(next++)), title: input.title, body: input.body })
      store.set(note.id, note)
      yield* Effect.annotateCurrentSpan({ id: note.id })
      return note
    })

    return Notes.of({
      // `list` is a value, not a method, so it is named with `withSpan` rather
      // than `Effect.fn`.
      list: Effect.sync(() => [...store.values()]).pipe(Effect.withSpan("Notes.list")),
      getById,
      create
    })
  })
}
