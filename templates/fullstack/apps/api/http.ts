import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { Api } from "../api/Api.ts"
import { webOrigin } from "../config.ts"
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

// The browser runs on a different origin to the API, so it needs CORS. Scoped to
// the web app's origin rather than "*", so this stays correct if the API is ever
// exposed beyond localhost.
//
// `traceparent` and `b3` are not optional: HttpTraceContext attaches both to
// every client request so a browser call joins the server's trace. Omitting them
// from the allow-list fails the preflight and the request never leaves the
// browser, whatever the handler does.
const CorsLayer = Layer.unwrap(Effect.map(webOrigin, (origin) =>
  HttpRouter.cors({
    allowedOrigins: [origin],
    allowedMethods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "traceparent", "b3"]
  })))

export const AllRoutes = Layer.mergeAll(ApiRoutes, DocsRoute, CorsLayer)
