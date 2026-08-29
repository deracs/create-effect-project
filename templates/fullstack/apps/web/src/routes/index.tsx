import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { createFileRoute } from "@tanstack/react-router"
import { Cause, Effect, Exit } from "effect"
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity"
import { useState } from "react"
import { createNote, notesList } from "../atoms/NotesApi.ts"

export const Route = createFileRoute("/")({
  component: Home,
  loader: async ({ context }) => {
    // Populate the registry before rendering, so the markup ships with data and
    // `dehydrate` has something to encode. The loader's job is to run the query,
    // not to judge it — the outcome is rendered by the onFailure branch below
    // rather than thrown into an error boundary.
    //
    // `Effect.exit`, not `Effect.ignore`: AtomHttpApi *dies* on a transport
    // error rather than failing, and `ignore` only swallows failures — a defect
    // escapes it and 500s the whole page when the API is unreachable. `exit`
    // captures both, so an API that is down renders the error branch.
    await Effect.runPromise(
      Effect.exit(AtomRegistry.getResult(notesList)(context.registry))
    )
  }
})

function Home() {
  const notes = useAtomValue(notesList)
  const created = useAtomValue(createNote)
  // `promiseExit` makes the mutation awaitable and hands back an Exit, so the
  // submit handler can act on the outcome directly.
  const submit = useAtomSet(createNote, { mode: "promiseExit" })
  const refreshNotes = useAtomRefresh(notesList)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")

  return (
    <main>
      <h1>Notes</h1>

      <form
        onSubmit={async (event) => {
          event.preventDefault()
          if (title.trim() === "") return
          const exit = await submit({ payload: { title, body } })
          // Only a success clears the fields, so a failed submission leaves the
          // user's input in place to retry. Reactivity keys would normally
          // refresh the list; see the comment in atoms/NotesApi.ts for why the
          // refresh is explicit instead.
          if (Exit.isSuccess(exit)) {
            refreshNotes()
            setTitle("")
            setBody("")
          }
        }}
      >
        <input
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          aria-label="Body"
          placeholder="Body"
          rows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <button type="submit">Add note</button>
      </form>

      {AsyncResult.isFailure(created) && (
        <p className="error">Could not add note: {Cause.pretty(created.cause)}</p>
      )}

      {AsyncResult.match(notes, {
        // Hydration removes the loading state on first paint, but not on a
        // client-side refetch of a cold atom, so this branch still earns its place.
        onInitial: () => <p>Loading…</p>,
        onFailure: (failure) => <p className="error">Could not load notes: {Cause.pretty(failure.cause)}</p>,
        onSuccess: (success) =>
          success.value.length === 0
            ? <p>No notes yet.</p>
            : (
              <ul>
                {success.value.map((note) => (
                  <li key={note.id}>
                    <strong>{note.title}</strong>
                    <div>{note.body}</div>
                  </li>
                ))}
              </ul>
            )
      })}
    </main>
  )
}
