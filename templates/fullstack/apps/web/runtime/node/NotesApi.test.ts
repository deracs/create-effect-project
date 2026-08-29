import { Api } from "@{{name}}/api/api"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AsyncResult, Atom, AtomHttpApi, AtomRegistry, Hydration } from "effect/unstable/reactivity"
import { expect, test } from "vitest"
import { notesList } from "./NotesApi.ts"

const stubNotes = [{ id: "1", title: "first", body: "hello" }]

let requests = 0

const StubHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    requests++
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(stubNotes), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    )
  })
)

class StubApi extends AtomHttpApi.Service<StubApi>()("test/StubApi", {
  api: Api,
  httpClient: StubHttpClient,
  baseUrl: "http://localhost"
}) {}

// Same group, endpoint and serializationKey as the shipped atom, so it produces
// the same registry key: `AtomHttpApi:notes:list:notes/list`.
const listQuery = Atom.keepAlive(
  StubApi.query("notes", "list", { serializationKey: "notes/list" })
)

test("dehydrates a resolved list and hydrates it without refetching", async () => {
  requests = 0

  const server = AtomRegistry.make()
  const notes = await Effect.runPromise(AtomRegistry.getResult(listQuery)(server))
  expect(notes.length).toBe(1)
  expect(requests).toBe(1)

  const dehydrated = Hydration.toValues(Hydration.dehydrate(server))
  expect(dehydrated.map((entry) => entry.key)).toContain("AtomHttpApi:notes:list:notes/list")

  const client = AtomRegistry.make()
  Hydration.hydrate(client, dehydrated)

  const hydrated = client.get(listQuery)
  expect(AsyncResult.isSuccess(hydrated)).toBe(true)
  // The whole point: reading the atom on the "client" issued no second request.
  expect(requests).toBe(1)
})

// Guards the shipped atom, not just the stub above: without a serializationKey
// it would not be serializable, dehydrate would skip it, and SSR would silently
// degrade into a client refetch.
test("the shipped notesList atom is serializable", () => {
  expect(Atom.isSerializable(notesList)).toBe(true)
})
