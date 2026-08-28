/**
 * Server entrypoint.
 *
 * A schema-first API (`src/api`) is implemented by handlers (`src/server`),
 * served over Node, and consumed by a generated typed client (`src/client`).
 *
 *   {{runCmd}} dev     # http://localhost:3000/docs
 */
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import { port } from "./config.ts"
import * as Observability from "./observability.ts"
import { AllRoutes } from "./server/http.ts"

const HttpServerLayer = HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(NodeHttpServer.layerConfig(createServer, { port }))
)

const Main = HttpServerLayer.pipe(
  // Provided at the very end, so every span the app creates is exported.
  Layer.provide(Observability.layer("{{name}}"))
)

Layer.launch(Main).pipe(NodeRuntime.runMain)
