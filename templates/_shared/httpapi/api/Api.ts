import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { NotesApiGroup } from "./Notes.ts"
import { SystemApi } from "./System.ts"

export class Api extends HttpApi.make("notes-api")
  .add(NotesApiGroup)
  .add(SystemApi)
  .annotateMerge(OpenApi.annotations({ title: "Notes API" }))
{}
