/**
 * The Notes service, exposed to the model as tools.
 *
 * The handlers are thin on purpose: each one calls the same `Notes` service the
 * `http-server` and `cli` templates call. The business logic is not duplicated
 * for the model's benefit, and it is not reachable except through the same
 * typed interface everything else uses.
 *
 * Parameters and results are schemas, so what the model sends is validated
 * before a handler sees it, and what a handler returns is validated before the
 * model sees it.
 */
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { Note, NoteId, NoteNotFound } from "./domain/Note.ts"
import { Notes } from "./server/Notes.ts"

const ListNotes = Tool.make("list_notes", {
  description: "List every note, with its id and title.",
  success: Schema.Array(Note)
})

const AddNote = Tool.make("add_note", {
  description: "Create a note with a title and a body.",
  parameters: Schema.Struct({
    title: Schema.String,
    body: Schema.String
  }),
  success: Note
})

const GetNote = Tool.make("get_note", {
  description: "Fetch one note by its id.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Note,
  // A missing note is a normal outcome of a model guessing an id, not a crash.
  // `failureMode: "return"` hands the failure back to the model as a result, so
  // it can apologise or try `list_notes` instead — rather than failing the
  // whole effect and taking the conversation with it.
  failure: NoteNotFound,
  failureMode: "return"
})

export const NotesToolkit = Toolkit.make(ListNotes, AddNote, GetNote)

export const layer = NotesToolkit.toLayer(Effect.gen(function*() {
  const notes = yield* Notes
  return NotesToolkit.of({
    list_notes: () => notes.list,
    add_note: ({ body, title }) => notes.create({ title, body }),
    get_note: ({ id }) => notes.getById(NoteId.make(id))
  })
}))
