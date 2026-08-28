import { Effect, Layer } from "effect"
import { NotesRpcs } from "../../rpc.ts"
import { Notes } from "../Notes.ts"

/**
 * The handlers are a thin adapter over the `Notes` service — the same service
 * the HTTP templates use. Business logic lives in `src/server/Notes.ts` and
 * knows nothing about RPC, so swapping the transport touches only this file.
 */
export const NotesRpcHandlers = NotesRpcs.toLayer(Effect.gen(function*() {
  const notes = yield* Notes
  return {
    list: () => notes.list,
    getById: ({ id }) => notes.getById(id),
    create: (payload) => notes.create(payload)
  }
})).pipe(Layer.provide(Notes.layerMemory))
