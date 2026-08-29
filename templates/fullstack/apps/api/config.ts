import { Config } from "effect"

export const port = Config.port("PORT").pipe(Config.withDefault(3000))

export const baseUrl = port.pipe(Config.map((port) => `http://localhost:${port}`))

/** The origin the web app is served from; used to scope CORS. */
export const webOrigin = Config.string("WEB_ORIGIN").pipe(
  Config.withDefault("http://localhost:3001")
)
