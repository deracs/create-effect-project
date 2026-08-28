import { Context, Effect, flow, Layer, Schedule } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { Api } from "../api/Api.ts"
import { baseUrl } from "../config.ts"

// The client's shape is derived from `Api`, so renames and schema changes are
// checked end-to-end at compile time.
export class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof Api>>()("app/ApiClient") {
  static readonly layer = Layer.effect(
    ApiClient,
    Effect.gen(function*() {
      const url = yield* baseUrl

      return yield* HttpApiClient.make(Api, {
        transformClient: (client) =>
          client.pipe(
            HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(url))),
            HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
          )
      })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
