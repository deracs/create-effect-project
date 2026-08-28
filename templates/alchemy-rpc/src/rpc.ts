/**
 * The RPC contract.
 *
 * One declaration produces the server's handler types and the client's method
 * signatures, so a rename or a schema change is a compile error on both sides —
 * the same guarantee `HttpApi` gives, without HTTP semantics in the way.
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Note, NoteCreate, NoteId, NoteNotFound } from "./domain/Note.ts"

const list = Rpc.make("list", {
  success: Schema.Array(Note)
})

const getById = Rpc.make("getById", {
  success: Note,
  // Typed failures cross the wire as themselves: the client gets a
  // `NoteNotFound`, not a status code it has to interpret.
  error: NoteNotFound,
  payload: { id: NoteId }
})

const create = Rpc.make("create", {
  success: Note,
  payload: NoteCreate.fields
})

export class NotesRpcs extends RpcGroup.make(list, getById, create) {}
