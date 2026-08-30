/**
 * The command tree.
 *
 * Three commands over the `Notes` service, which is the same service the
 * server templates put behind HTTP and RPC. Nothing here opens a file or a
 * socket — the handlers ask for `Notes` and something else decides what that is.
 *
 *   {{runCmd}} dev -- add "Buy milk" --body "2 litres"
 *   {{runCmd}} dev -- list
 *   {{runCmd}} dev -- get 1
 */
import { Effect } from "effect"
import { Argument, CliError, Command, Flag, Prompt } from "effect/unstable/cli"
import { NoteId } from "./domain/Note.ts"
import { Notes } from "./server/Notes.ts"

// `withFallbackPrompt` is what makes the same command work both ways: given a
// title it takes it, and given nothing it asks. Scripts pass arguments, people
// get prompted, and there is one code path.
const title = Argument.string("title").pipe(
  Argument.withDescription("Title of the note"),
  Argument.withFallbackPrompt(Prompt.text({ message: "Title" }))
)

const body = Flag.string("body").pipe(
  Flag.withAlias("b"),
  Flag.withDescription("Body of the note"),
  Flag.withDefault("")
)

const add = Command.make(
  "add",
  { title, body },
  Effect.fn(function*(input) {
    const notes = yield* Notes
    const note = yield* notes.create({ title: input.title, body: input.body })
    yield* Effect.log(`Added ${note.id}: ${note.title}`)
  })
).pipe(Command.withDescription("Add a note"))

const list = Command.make(
  "list",
  {},
  Effect.fn(function*() {
    const notes = yield* Notes
    const all = yield* notes.list
    if (all.length === 0) {
      yield* Effect.log("No notes yet — add one with `add`.")
      return
    }
    for (const note of all) {
      yield* Effect.log(`${note.id}\t${note.title}`)
    }
  })
).pipe(Command.withDescription("List every note"))

const get = Command.make(
  "get",
  { id: Argument.string("id").pipe(Argument.withDescription("Id of the note")) },
  Effect.fn(function*(input) {
    const notes = yield* Notes
    const note = yield* notes.getById(NoteId.make(input.id)).pipe(
      // `NoteNotFound` is in the handler's error type, so this must be handled:
      // delete the `catchTag` and it is a compile error. Turning it into a
      // `UserError` is what makes a missing note one sentence and exit 1,
      // rather than a tag and a stack trace.
      Effect.catchTag("NoteNotFound", (error) =>
        new CliError.UserError({
          cause: error,
          userMessage: `No note with id ${error.id}`
        }))
    )
    yield* Effect.log(`${note.id}\t${note.title}`)
    if (note.body !== "") {
      yield* Effect.log(note.body)
    }
  })
).pipe(Command.withDescription("Show one note by id"))

export const root = Command.make("{{name}}").pipe(
  Command.withDescription("Notes, on the command line"),
  Command.withSubcommands([add, list, get]),
  Command.withExamples([
    { command: "{{name}} add \"Buy milk\" --body \"2 litres\"", description: "Add a note" },
    { command: "{{name}} add", description: "Add a note, prompting for the title" },
    { command: "{{name}} list", description: "List every note" },
    { command: "{{name}} get 1", description: "Show one note" }
  ])
)
