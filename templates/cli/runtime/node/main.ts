/**
 * CLI entrypoint.
 *
 * Wires the command tree (`src/commands.ts`) to a `Notes` implementation. The
 * commands do not know which one they get — swap `NotesFile.layer` for
 * `Notes.layerMemory` and every command still compiles, it just forgets
 * everything on exit.
 *
 *   {{runCmd}} dev -- list
 *   {{runCmd}} dev -- add "Buy milk" --body "2 litres"
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { root } from "./commands.ts"
import * as NotesFile from "./NotesFile.ts"
import * as Observability from "./observability.ts"

const MainLayer = Layer.mergeAll(
  NotesFile.layer,
  Observability.layer("{{name}}")
).pipe(
  // The platform services the CLI needs: a file system for the note store, and
  // a terminal for the prompts.
  Layer.provideMerge(NodeServices.layer)
)

root.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(MainLayer),
  NodeRuntime.runMain
)
