import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"

// Setting this turns telemetry on; leaving it unset makes the layer a no-op, so
// nothing tries to export during ordinary local runs.
//
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 {{runCmd}} dev
const endpoint = Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
  Config.map((url) => url.replace(/\/$/, "")),
  Config.option
)

/** Exports logs, metrics and traces over OTLP/HTTP beneath the configured endpoint. */
export const layer = (serviceName: string) =>
  Layer.unwrap(Effect.map(
    endpoint,
    (endpoint) =>
      endpoint._tag === "None" ? Layer.empty : Otlp.layerJson({
        baseUrl: endpoint.value,
        resource: { serviceName, serviceVersion: "0.0.1" }
      })
  )).pipe(Layer.provide(FetchHttpClient.layer))
