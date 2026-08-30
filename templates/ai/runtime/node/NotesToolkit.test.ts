import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, References, Stream } from "effect"
import { LanguageModel, type Response, type Tool } from "effect/unstable/ai"
import { layer as NotesToolkitLayer, NotesToolkit } from "./NotesToolkit.ts"
import { Notes } from "./server/Notes.ts"

/**
 * A `LanguageModel` that replies with exactly these parts.
 *
 * `LanguageModel` is the seam, so the tests need no API key, no network and no
 * mocking library — the real toolkit, the real schemas and the real handlers all
 * run, and only the provider is swapped out. That is also why the test can
 * assert on a tool call: it decides what the model "chose" to do.
 */
const stubModel = (parts: ReadonlyArray<Response.PartEncoded>) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([...parts]),
      streamText: () => Stream.empty
    })
  )

/**
 * What a test body may ask for: the model, the service, and the tool handlers
 * the toolkit layer supplies. The last one is derived from the toolkit rather
 * than written out, so adding a tool does not mean editing this type.
 */
type Provided =
  | LanguageModel.LanguageModel
  | Notes
  | Tool.HandlersFor<(typeof NotesToolkit)["tools"]>

const run = <A, E>(
  parts: ReadonlyArray<Response.PartEncoded>,
  effect: Effect.Effect<A, E, Provided>
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(stubModel(parts), NotesToolkitLayer).pipe(
        // `provideMerge` so the handlers and the assertions share one store.
        Layer.provideMerge(Notes.layerMemory)
      )
    ),
    // Keep the output to the assertions; raise this to see app logs.
    Effect.provideService(References.MinimumLogLevel, "None")
  )

describe("the notes toolkit", () => {
  it.effect("runs a tool call against the real service", () =>
    run(
      [
        {
          type: "tool-call",
          id: "call_1",
          name: "add_note",
          params: { title: "Buy milk", body: "2 litres" }
        },
        { type: "text", text: "Added it." }
      ],
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({
          prompt: "add a note about milk",
          toolkit: NotesToolkit
        })
        assert.strictEqual(response.text, "Added it.")

        // The point of the assertion: the tool call reached the same `Notes`
        // service the HTTP and CLI templates use, and actually created a note.
        const listed = yield* Effect.flatMap(Notes, (notes) => notes.list)
        assert.strictEqual(listed.length, 1)
        assert.strictEqual(listed[0]?.title, "Buy milk")
        assert.strictEqual(listed[0]?.body, "2 litres")
      })
    ))

  it.effect("hands a missing note back to the model instead of failing", () =>
    run(
      [{ type: "tool-call", id: "call_1", name: "get_note", params: { id: "999" } }],
      Effect.gen(function*() {
        // `failureMode: "return"` is what makes this a result rather than a
        // failed effect — the model gets to see the mistake and recover.
        const response = yield* LanguageModel.generateText({
          prompt: "show me note 999",
          toolkit: NotesToolkit
        })
        const [result] = response.toolResults
        assert.isDefined(result)
        assert.strictEqual(result?.name, "get_note")
      })
    ))

  it.effect("rejects tool arguments that do not match the schema", () =>
    run(
      [{ type: "tool-call", id: "call_1", name: "add_note", params: { title: 42 } }],
      Effect.gen(function*() {
        // The parameters are a schema, so a model that sends the wrong shape is
        // stopped before any handler runs — nothing was written.
        yield* Effect.ignore(LanguageModel.generateText({
          prompt: "add a note",
          toolkit: NotesToolkit
        }))
        const listed = yield* Effect.flatMap(Notes, (notes) => notes.list)
        assert.strictEqual(listed.length, 0)
      })
    ))
})
