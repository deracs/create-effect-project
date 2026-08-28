/**
 * Client entrypoint — calls the RPC group as ordinary typed methods.
 *
 * Point it at the deployed Worker, or at `{{runCmd}} dev`:
 *
 *   API_URL=https://... {{runCmd}} client
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { baseUrl } from "./config.ts"
import { NoteId } from "./domain/Note.ts"
import { NotesRpcs } from "./rpc.ts"

const program = Effect.gen(function*() {
  // The client's methods are derived from the group, so this call is checked
  // against the server's handler at compile time.
  const client = yield* RpcClient.make(NotesRpcs)

  const created = yield* client.create({ title: "first", body: "hello" })
  yield* Effect.logInfo("created", created)

  const fetched = yield* client.getById({ id: created.id })
  yield* Effect.logInfo("getById", fetched)

  const all = yield* client.list()
  yield* Effect.logInfo("list", all)

  // The error arrives as `NoteNotFound` itself — no status code to decode.
  const missing = yield* client.getById({ id: NoteId.make("nope") }).pipe(
    Effect.catchTag("NoteNotFound", (error) => Effect.succeed(`no note ${error.id} — handled`))
  )
  yield* Effect.logInfo("getById?id=nope", missing)
})

const ClientLayer = Layer.unwrap(Effect.map(baseUrl, (url) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerNdjson)
  )))

program.pipe(Effect.scoped, Effect.provide(ClientLayer), NodeRuntime.runMain)
