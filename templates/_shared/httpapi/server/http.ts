import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { Api } from "../api/Api.ts"
import { NotesApiHandlers } from "./Notes/http.ts"

const SystemApiHandlers = HttpApiBuilder.group(
  Api,
  "system",
  (handlers) => handlers.handleAll({ health: () => Effect.void })
)

const ApiRoutes = HttpApiBuilder.layer(Api, {
  openapiPath: "/openapi.json"
}).pipe(Layer.provide([NotesApiHandlers, SystemApiHandlers]))

const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" })

export const AllRoutes = Layer.mergeAll(ApiRoutes, DocsRoute)
