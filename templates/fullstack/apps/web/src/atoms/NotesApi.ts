/**
 * The web app's data layer: query and mutation atoms derived from the same
 * `HttpApi` definition the server implements, so a schema change is a compile
 * error here too.
 *
 * This module reads `import.meta.env`, so it belongs to the web app and must
 * not move into a package the server imports.
 */
import { Api } from "@{{name}}/api/api"
import { FetchHttpClient } from "effect/unstable/http"
import { Atom, AtomHttpApi } from "effect/unstable/reactivity"

const baseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000"

export class NotesApi extends AtomHttpApi.Service<NotesApi>()("web/NotesApi", {
  api: Api,
  httpClient: FetchHttpClient.layer,
  baseUrl
}) {}

export const notesList = Atom.keepAlive(
  NotesApi.query("notes", "list", {
    // The identity for the SSR -> client handoff. Without it the atom is not
    // serializable, `Hydration.dehydrate` skips it, and the client refetches on
    // mount — an app that looks right while doing the wrong thing. The
    // round-trip test in this directory is what guards it.
    serializationKey: "notes/list"
  })
)

// `reactivityKeys` is deliberately absent. Combining it with `serializationKey`
// breaks hydration in effect 4.0.0-rc.112: the preload seeds a node keyed by
// object identity rather than the serialization string, so the first client
// read refetches anyway. To retest after upgrading effect, add
// `reactivityKeys: ["notes"]` to the query above and to the stub in
// NotesApi.test.ts — if `expect(requests).toBe(1)` still fails, it is not fixed.
//
// Until then the list is refreshed explicitly after a successful mutation; see
// routes/index.tsx.
export const createNote = NotesApi.mutation("notes", "create")
