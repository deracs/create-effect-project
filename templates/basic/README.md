# {{name}}

A plain Effect v4 program — a service, a typed error, and a `main` that runs and exits.
No server, no build step: the runtime executes TypeScript directly.

## Run it

```bash
{{runCmd}} dev      # watch mode
{{runCmd}} start    # once
{{runCmd}} test
```

## What's here

| File | What |
| --- | --- |
| `src/domain/User.ts` | The domain: a `Schema.Class`, a branded `UserId`, and a `UserNotFound` error |
| `src/Users.ts` | A `Context.Service` — an interface, a tag, and `layerMemory` supplying it |
| `src/main.ts` | The program: create, fetch, list, and handle the failure |
| `src/Users.test.ts` | Tests against the real layer |

## The shape to copy

`src/Users.ts` is the pattern worth reusing. The interface is what callers depend on;
`layerMemory` is one implementation of it. Replacing it with a database-backed layer is a
change to that one file — `main.ts` and the tests keep compiling, because neither mentions
the implementation.

Failures work the same way. `getById` returns `Effect<User, UserNotFound>`, so the error is
part of the type. `main.ts` has to handle it; deleting the `Effect.catchTag` is a compile
error rather than an unhandled rejection in production.

## Tests

```bash
{{runCmd}} test
```

They run against `Users.layerMemory` — the real implementation, not a mock. When you add a
database layer, keep the in-memory one for tests: the seam is the layer, so nothing needs
stubbing.

## Telemetry

`src/observability.ts` exports logs, metrics and traces over OTLP/HTTP. It is a no-op unless
`OTEL_EXPORTER_OTLP_ENDPOINT` is set:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 {{runCmd}} start
```

The `Effect.fn("Users.getById")` names in `src/Users.ts` are the span names you will see.
