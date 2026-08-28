/**
 * Cloudflare Worker entrypoint.
 *
 * The same `AllRoutes` the local server uses, converted to a fetch handler
 * instead of being bound to a port. Nothing under `src/api`, `src/server` or
 * `src/client` changes between the two — one HttpApi definition, two targets.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { AllRoutes } from "./server/http.ts"

export default Cloudflare.Worker(
  "{{name}}",
  { main: import.meta.url },
  Effect.succeed({
    // `layerServices` supplies the file-serving services the OpenAPI and Scalar
    // routes ask for, backed by a no-op filesystem — a Worker has no disk, and
    // those routes serve generated content rather than files.
    fetch: HttpRouter.toHttpEffect(AllRoutes).pipe(Effect.provide(HttpServer.layerServices))
  })
)
