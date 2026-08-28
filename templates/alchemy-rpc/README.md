# {{name}}

An Effect v4 RPC service deployed to a Cloudflare Worker with
[Alchemy](https://alchemy.run) — infrastructure as Effects, no YAML and no `wrangler.toml`.

## Run it

```bash
npx alchemy login       # once, connects your Cloudflare account
{{runCmd}} dev          # local
{{runCmd}} plan         # what would change
{{runCmd}} deploy       # apply it — prints the URL
{{runCmd}} destroy      # tear it down
```

## RPC instead of HTTP

`src/rpc.ts` declares the contract once. The server's handler types and the client's method
signatures both come from it, so a rename or a schema change is a compile error on both sides:

```ts
const getById = Rpc.make("getById", {
  success: Note,
  error: NoteNotFound,
  payload: { id: NoteId }
})
```

Calling it is a method call, not a request:

```ts
const client = yield* RpcClient.make(NotesRpcs)
const note = yield* client.getById({ id })
```

The difference from the HttpApi templates is what crosses the wire. `NoteNotFound` arrives as
**itself** — `Effect.catchTag("NoteNotFound", ...)` on the client — rather than as a 404 the caller
has to interpret. There are no paths, no verbs and no status codes to agree on. What you give up is
everything that comes from being ordinary HTTP: no OpenAPI document, no Scalar page, and no `curl`.

Scaffold `--template alchemy-http` instead if you want a public, documented API.

## What's here

| File | What |
| --- | --- |
| `src/rpc.ts` | The contract — `Rpc.make` procedures collected into an `RpcGroup` |
| `src/domain/Note.ts` | The domain: a `Schema.Class`, a branded `NoteId`, a `NoteNotFound` error |
| `src/server/Notes.ts` | The `Notes` service — plain business logic, knows nothing about RPC |
| `src/server/Notes/rpc.ts` | The handlers: a thin adapter from the group onto that service |
| `src/worker.ts` | The Worker — `RpcWorker` takes the group as `schema` |
| `alchemy.run.ts` | The stack |
| `src/client.ts` | A runnable demo client |

`src/server/Notes.ts` is the same file the HTTP templates use. Logic lives there and the transport
adapter is `src/server/Notes/rpc.ts`, so moving between RPC and HTTP touches one file.

## Infrastructure

`alchemy.run.ts` is ordinary TypeScript returning an Effect. Adding a bucket is a value, not a
config file:

```ts
const Uploads = Cloudflare.R2.Bucket("Uploads")
// then, inside the worker's init:
const uploads = yield* Cloudflare.R2.ReadWriteBucket(Uploads)
```

## Tests

```bash
{{runCmd}} test
```

`RpcTest.makeClient` runs the real encode/decode round trip against the handlers in-process — no
Worker, no port, and no Cloudflare account. These are the tests CI can run.

## Telemetry

Not wired up. OTLP export from inside a Worker isolate is not the right shape for Cloudflare —
use [Workers Observability](https://developers.cloudflare.com/workers/observability/) or a
[tail worker](https://developers.cloudflare.com/workers/observability/logs/tail-workers/), and
`{{runCmd}} tail` to stream logs. That is why `--otel` does not apply to this template.
