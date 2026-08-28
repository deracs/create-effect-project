import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../../api/Api.ts"
import { Notes } from "../Notes.ts"

export const NotesApiHandlersNoDeps = HttpApiBuilder.group(
  Api,
  "notes",
  Effect.fn(function*(handlers) {
    const notes = yield* Notes

    return handlers.handleAll({
      list: () => notes.list,
      getById: ({ params }) => notes.getById(params.id),
      create: ({ payload }) => notes.create(payload)
    })
  })
)

export const NotesApiHandlers = NotesApiHandlersNoDeps.pipe(
  Layer.provide(Notes.layerMemory)
)
