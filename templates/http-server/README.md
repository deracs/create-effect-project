# {{name}}

A schema-first HTTP API built with Effect v4 — server, OpenAPI docs, and a typed client
generated from one definition.

## Run it

```bash
{{runCmd}} dev      # watch mode
{{runCmd}} start    # once
```

| Route | What |
| --- | --- |
| `GET /health` | Liveness probe (204) |
| `GET /notes` | List notes |
| `POST /notes` | Create a note |
| `GET /notes/:id` | Fetch one (404 `NoteNotFound` if absent) |
| `GET /openapi.json` | Generated OpenAPI document |
| `GET /docs` | Scalar API reference |

The port comes from `PORT`, defaulting to 3000.

## The typed client

`src/client/ApiClient.ts` derives its shape from `src/api/Api.ts`, so renaming an endpoint
or changing a schema is a compile error on both sides. `src/client.ts` is a runnable demo:

```bash
{{runCmd}} dev       # one terminal
{{runCmd}} client    # another
```

## Adding an endpoint

1. Declare it in `src/api/Notes.ts` (or a new group added to `src/api/Api.ts`).
2. Implement it in `src/server/Notes/http.ts` — the handler list is type-checked against the
   declaration, so a missing handler will not compile.

## Tests

```bash
{{runCmd}} test
```

Tests use `HttpApiTest.groups`, which runs the real request encoding, routing and response
decoding against the handlers with no server and no port.

## Telemetry

`src/observability.ts` exports logs, metrics and traces over OTLP/HTTP. It is a no-op unless
`OTEL_EXPORTER_OTLP_ENDPOINT` is set:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 {{runCmd}} dev
```
