/**
 * Program entrypoint.
 *
 * Asks a language model to do something, having handed it the Notes service as
 * tools. The model decides which tools to call and with what; the framework
 * validates the arguments against the tool's schema, runs the handler, and
 * validates what comes back.
 *
 *   ANTHROPIC_API_KEY=sk-... {{runCmd}} start
 *   ANTHROPIC_API_KEY=sk-... {{runCmd}} start -- "what notes do I have?"
 */
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as AiModel from "./AiModel.ts"
import { layer as NotesToolkitLayer, NotesToolkit } from "./NotesToolkit.ts"
import * as Observability from "./observability.ts"
import { Notes } from "./server/Notes.ts"

const prompt = process.argv.slice(2).join(" ") ||
  "Add a note titled 'Buy milk' with the body '2 litres', then list every note."

const program = Effect.gen(function*() {
  const response = yield* LanguageModel.generateText({
    prompt,
    toolkit: NotesToolkit
  })

  // What the model chose to do, before what it said about it — the tool calls
  // are the only part that touched real state.
  for (const call of response.toolCalls) {
    yield* Effect.logInfo("tool call", { name: call.name, params: call.params })
  }
  for (const result of response.toolResults) {
    yield* Effect.logInfo("tool result", { name: result.name, result: result.result })
  }
  yield* Effect.logInfo(response.text === "" ? "(the reply carried no text)" : response.text)
}).pipe(
  Effect.withSpan("main"),
  Effect.provide(
    Layer.mergeAll(
      AiModel.layer,
      NotesToolkitLayer,
      Observability.layer("{{name}}")
    ).pipe(
      // Provided once, beneath everything: the tool handlers and anything else
      // that asks for `Notes` must share one store, not get a Map each.
      Layer.provide(Notes.layerMemory)
    )
  )
)

program.pipe(BunRuntime.runMain)
