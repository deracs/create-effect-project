/**
 * The stack: what gets deployed, and what it reports back.
 *
 *   {{runCmd}} plan      # what would change
 *   {{runCmd}} deploy    # apply it, prints the URL
 *   {{runCmd}} destroy   # tear it down
 *
 * Deploying needs a Cloudflare account — `npx alchemy login` once.
 */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import Worker from "./src/worker.ts"

export default Alchemy.Stack(
  "{{name}}",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    const worker = yield* Worker
    return { url: worker.url }
  })
)
