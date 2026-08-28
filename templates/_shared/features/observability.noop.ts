import { Layer } from "effect"

/**
 * Telemetry is not wired up in this project.
 *
 * To add OTLP export of logs, metrics and traces, scaffold again with `--otel`,
 * or replace this file with `Otlp.layerJson` from `effect/unstable/observability`.
 */
export const layer = (_serviceName: string) => Layer.empty
