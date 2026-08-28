import { Config } from "effect"

export const port = Config.port("PORT").pipe(Config.withDefault(3000))

/**
 * Where the client points.
 *
 * `API_URL` wins, so the same client can talk to a deployed instance — set it
 * to the URL `deploy` printed. Otherwise it is the local server on `PORT`.
 */
export const baseUrl = Config.string("API_URL").pipe(
  Config.orElse(() => port.pipe(Config.map((port) => `http://localhost:${port}`)))
)
