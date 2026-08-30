# {{name}}

A language model given real, typed tools — Effect v4's AI module wired to Anthropic or
OpenAI, with the Notes service exposed as a toolkit the model can call.

## Run it

```bash
export ANTHROPIC_API_KEY=sk-...
{{runCmd}} start
{{runCmd}} start -- "what notes do I have?"
{{runCmd}} test          # no key needed
```

Switch providers without touching anything but the environment:

```bash
export OPENAI_API_KEY=sk-...
AI_PROVIDER=openai {{runCmd}} start
AI_MODEL=claude-haiku-4-5 {{runCmd}} start
```

## What's here

| File | What |
| --- | --- |
| `src/domain/Note.ts` | The domain: a `Schema.Class`, a branded `NoteId`, and a `NoteNotFound` error |
| `src/server/Notes.ts` | A `Context.Service` — the business logic, which knows nothing about AI |
| `src/NotesToolkit.ts` | That service exposed as three tools, with schemas for arguments and results |
| `src/AiModel.ts` | Which provider backs `LanguageModel`, chosen from configuration |
| `src/main.ts` | Sends a prompt with the toolkit attached and reports what happened |
| `src/NotesToolkit.test.ts` | Tests against a stubbed model — no key, no network |

`src/server/Notes.ts` keeps its path because it is shared, byte for byte, with the
`http-server`, `cli` and `alchemy-*` templates. The model gets the same service your API
serves, through the same typed interface — not a copy written for its benefit.

## The provider is a layer

`src/AiModel.ts` builds `Layer<LanguageModel, ConfigError>` from either provider. Both
branches have that same type, which is the whole trick: `src/NotesToolkit.ts` and
`src/main.ts` name `LanguageModel` and never name Anthropic or OpenAI, so switching is one
file, and testing is a third implementation of the same interface.

## Tools are schemas, not prompt engineering

Each tool declares its parameters and results as schemas:

```ts
const AddNote = Tool.make("add_note", {
  description: "Create a note with a title and a body.",
  parameters: Schema.Struct({ title: Schema.String, body: Schema.String }),
  success: Note
})
```

The schema is what the model is shown, and it is what validates the call. A model that
sends `{ title: 42 }` is stopped before your handler runs — there is a test for exactly
that. The handler itself is one line, because the logic already exists:

```ts
add_note: ({ body, title }) => notes.create({ title, body })
```

`get_note` declares `failure: NoteNotFound` with `failureMode: "return"`, so a model that
guesses a bad id gets the failure back as a result and can recover, instead of taking the
whole conversation down.

## Tests without an API key

`src/NotesToolkit.test.ts` provides a `LanguageModel` built with `LanguageModel.make` that
replies with whatever parts the test names — including tool calls. The real toolkit, the
real schemas and the real handlers all run against the real service. Only the provider is
swapped.

That is why `{{runCmd}} test` needs no key, no network and no mocking library.

## Going further

`generateText` is one turn. For a conversation that keeps history across turns, see `Chat`
in `effect/unstable/ai`; for token-by-token output, `LanguageModel.streamText`. Structured
output is `LanguageModel.generateObject`, which takes a schema and gives you back a value
of that type rather than a string to parse.

## Telemetry

`src/observability.ts` exports logs, metrics and traces over OTLP/HTTP. It is a no-op
unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 {{runCmd}} start
```

The AI module emits spans of its own, so you get the model call, its token usage and every
tool call nested underneath, alongside the `Notes.create` spans the service already had.
