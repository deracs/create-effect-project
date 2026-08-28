# {{name}}

A schema-first Effect v4 `HttpApi` deployed to a Cloudflare Worker with
[Alchemy](https://alchemy.run) — infrastructure as Effects, no YAML and no `wrangler.toml`.

## Run it

```bash
npx alchemy login       # once, connects your Cloudflare account
{{runCmd}} dev          # local
{{runCmd}} plan         # what would change
{{runCmd}} deploy       # apply it — prints the URL
{{runCmd}} destroy      # tear it down
```

| Route | What |
| --- | --- |
| `GET /health` | Liveness probe (204) |
| `GET /notes` | List notes |
| `POST /notes` | Create a note |
| `GET /notes/:id` | Fetch one (404 `NoteNotFound` if absent) |
| `GET /openapi.json` | Generated OpenAPI document |
| `GET /docs` | Scalar API reference |

## The point

`src/api`, `src/server` and `src/client` are **identical** to the local-server template. The
only difference is the entrypoint: instead of binding `AllRoutes` to a port, `src/worker.ts`
converts it to a fetch handler.

```ts
// a local server
HttpRouter.serve(AllRoutes).pipe(Layer.provide(NodeHttpServer.layerConfig(createServer, { port })))

// a Cloudflare Worker
HttpRouter.toHttpEffect(AllRoutes).pipe(Effect.provide(HttpServer.layerServices))
```

One `HttpApi` definition, either target. `HttpServer.layerServices` supplies the file-serving
services the OpenAPI and Scalar routes ask for, backed by a no-op filesystem — a Worker has no
disk, and those routes serve generated content.

## Infrastructure

`alchemy.run.ts` is the stack: ordinary TypeScript returning an Effect. Adding a bucket is a
value, not a config file:

```ts
const Uploads = Cloudflare.R2.Bucket("Uploads")
// then, inside the worker's init:
const uploads = yield* Cloudflare.R2.ReadWriteBucket(Uploads)
```

## The typed client

`src/client/ApiClient.ts` derives its shape from `src/api/Api.ts`, so renaming an endpoint or
changing a schema is a compile error on both sides. It reads `API_URL`, so the same client works
against a deployed Worker:

```bash
API_URL=https://your-worker.workers.dev {{runCmd}} client
```

## Tests

```bash
{{runCmd}} test
```

`HttpApiTest.groups` runs the real request encoding, routing and response decoding against the
handlers — no Worker, no port, no Cloudflare account. These are the same tests the local-server
template runs, because they test the same handlers.

## Telemetry

Not wired up. OTLP export from inside a Worker isolate is not the right shape for Cloudflare —
use [Workers Observability](https://developers.cloudflare.com/workers/observability/) or a
[tail worker](https://developers.cloudflare.com/workers/observability/logs/tail-workers/), and
`{{runCmd}} tail` to stream logs. That is why `--otel` does not apply to this template.
