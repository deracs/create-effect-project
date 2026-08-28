/**
 * Cloudflare Worker entrypoint.
 *
 * `RpcWorker` takes the group as `schema`, so the deployed Worker and any
 * consumer that imports this class agree on the contract by construction.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { NotesRpcs } from "./rpc.ts"
import { NotesRpcHandlers } from "./server/Notes/rpc.ts"

export default class Worker extends Cloudflare.RpcWorker<Worker>()(
  "{{name}}",
  { main: import.meta.url, schema: NotesRpcs },
  // `Effect.succeed` rather than `Effect.gen`: the outer effect is one-time
  // init, the inner one serves each request. Returning the inner effect from a
  // generator produces the same nesting but reads like a mistake.
  Effect.succeed(
    RpcServer.toHttpEffect(NotesRpcs).pipe(
      Effect.provide(Layer.mergeAll(NotesRpcHandlers, RpcSerialization.layerNdjson))
    )
  )
) {}
