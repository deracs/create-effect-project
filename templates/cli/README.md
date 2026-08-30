# {{name}}

A command-line app built with Effect v4's CLI module — subcommands, arguments, flags,
prompts, and a typed error that becomes a clean exit code. No build step: the runtime
executes TypeScript directly.

## Run it

```bash
{{runCmd}} dev -- add "Buy milk" --body "2 litres"
{{runCmd}} dev -- list
{{runCmd}} dev -- get 1
{{runCmd}} dev -- --help
{{runCmd}} test
```

The `--` is what stops your package manager from eating the arguments and passes them to
the CLI instead.

Notes are kept in `.notes.json` in the working directory. Set `NOTES_FILE` to move it.

## What's here

| File | What |
| --- | --- |
| `src/domain/Note.ts` | The domain: a `Schema.Class`, a branded `NoteId`, and a `NoteNotFound` error |
| `src/server/Notes.ts` | A `Context.Service` — the interface every command depends on |
| `src/NotesFile.ts` | A second implementation of that service, backed by a JSON file |
| `src/commands.ts` | The command tree: `add`, `list`, `get` |
| `src/main.ts` | Wires the tree to an implementation and runs it |
| `src/NotesFile.test.ts` | Tests against the real file-backed layer |

`src/server/Notes.ts` keeps its path because it is shared, byte for byte, with the
`http-server`, `alchemy-http` and `alchemy-rpc` templates. Same service, same business
logic — one puts it behind a port, one behind a Worker, this one behind `argv`.

## Two implementations, one interface

`src/server/Notes.ts` ships `layerMemory`, a `Map`. That is right for a server, which
outlives every request, and wrong for a CLI, which exits after one — `add` in one
invocation and `list` in the next would disagree. So `src/NotesFile.ts` implements the
same interface against a JSON file.

Nothing in `src/commands.ts` changed to make that work, because nothing in it names an
implementation. Swap the layer in `src/main.ts`:

```ts
const MainLayer = Layer.mergeAll(
  Notes.layerMemory,          // instead of NotesFile.layer
  Observability.layer("{{name}}")
)
```

...and every command still compiles. It just forgets everything on exit. That is the whole
argument for the service pattern, in one line of diff.

## Errors are exit codes

`getById` returns `Effect<Note, NoteNotFound>`, so the failure is in the type and the
handler has to deal with it. `src/commands.ts` turns it into a `CliError.UserError`:

```bash
$ {{runCmd}} dev -- get 999
No note with id 999
$ echo $?
1
```

One sentence and a non-zero exit, rather than a tag and a stack trace. Delete the
`Effect.catchTag` and it is a compile error, not a surprise in someone's shell script.

The opposite case is deliberate too. Hand-edit `.notes.json` into something that is not valid
JSON and you get a stack trace, because that is a defect rather than a domain error — it is not
in any type, nothing can sensibly recover from it, and the trace names the file. Errors you plan
for are typed and handled; the rest are allowed to crash loudly.

## Arguments, flags and prompts

`add` takes its title as an argument, but `Argument.withFallbackPrompt` means omitting it
is not an error — the CLI asks:

```bash
$ {{runCmd}} dev -- add
? Title › ...
```

Scripts pass arguments and people get prompted, through one code path. `--help` is
generated from the same definitions, so it cannot drift from what the commands accept.

## Shipping it as a real command

The scripts run through your package manager. To install it as a binary instead, add a
`bin` entry pointing at a small JavaScript shim that runs `src/main.ts`, or compile ahead
of time — `bun build --compile` produces a single executable with no runtime needed.

## Telemetry

`src/observability.ts` exports logs, metrics and traces over OTLP/HTTP. It is a no-op
unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 {{runCmd}} start -- list
```

The `Effect.fn("NotesFile.create")` names are the spans you will see.
