/**
 * Which model backs `LanguageModel`, chosen at startup from configuration.
 *
 * Both branches build the same type — `Layer<LanguageModel, ConfigError>` — and
 * that is the point worth noticing. `LanguageModel` is the seam: the toolkit,
 * the handlers and `main.ts` name it and never name a provider, so switching
 * between them is this file and nothing else.
 *
 *   AI_PROVIDER=openai {{runCmd}} start
 *   AI_MODEL=claude-haiku-4-5 {{runCmd}} start
 */
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

export const provider = Config.literals(["anthropic", "openai"], "AI_PROVIDER").pipe(
  Config.withDefault("anthropic" as const)
)

/** Overrides the provider's default. Any id the provider accepts will do. */
const model = Config.string("AI_MODEL").pipe(Config.option)

// Named here rather than inline so there is one place to bump them.
const defaultModel = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.4"
} as const

const anthropic = (model: string) =>
  AnthropicLanguageModel.layer({ model }).pipe(
    Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
    Layer.provide(FetchHttpClient.layer)
  )

const openai = (model: string) =>
  OpenAiLanguageModel.layer({ model }).pipe(
    Layer.provide(OpenAiClient.layerConfig({ apiKey: Config.redacted("OPENAI_API_KEY") })),
    Layer.provide(FetchHttpClient.layer)
  )

export const layer = Layer.unwrap(Effect.gen(function*() {
  const chosen = yield* provider
  const configured = yield* model
  const name = configured._tag === "Some" ? configured.value : defaultModel[chosen]
  return chosen === "openai" ? openai(name) : anthropic(name)
}))
