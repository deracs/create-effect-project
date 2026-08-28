import { Schema } from "effect"

export const NoteId = Schema.String.pipe(Schema.brand("NoteId"))
export type NoteId = typeof NoteId.Type

export class Note extends Schema.Class<Note>("Note")({
  id: NoteId,
  title: Schema.String,
  body: Schema.String
}) {}

export const NoteCreate = Schema.Struct({
  title: Schema.String,
  body: Schema.String
})

export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()("NoteNotFound", {
  id: NoteId
}) {}
