import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Note, NoteCreate, NoteId, NoteNotFound } from "../domain/Note.ts"

export class NotesApiGroup extends HttpApiGroup.make("notes")
  .add(
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(Note)
    }),
    HttpApiEndpoint.get("getById", "/:id", {
      params: { id: NoteId },
      success: Note,
      error: NoteNotFound.pipe(HttpApiSchema.status(404))
    }),
    HttpApiEndpoint.post("create", "/", {
      payload: NoteCreate,
      success: Note
    })
  )
  .prefix("/notes")
  .annotateMerge(OpenApi.annotations({
    title: "Notes",
    description: "Note management endpoints"
  }))
{}
