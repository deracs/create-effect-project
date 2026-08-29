# {{name}}

One `HttpApi` definition, served by an Effect v4 backend and consumed by a
server-rendered React frontend whose data comes from Effect's own reactivity —
no separate data-fetching library.

```
apps/api    the schema-first HttpApi server, on :3000
apps/web    TanStack Start + Effect atoms, on :3001
```

## Run it

Two terminals, because the two apps are separate processes:

```bash
cd apps/api && {{runCmd}} dev     # http://localhost:3000/docs
cd apps/web && {{runCmd}} dev     # http://localhost:3001
```

`apps/api` reads `PORT` (default 3000) and `WEB_ORIGIN` (default
`http://localhost:3001`), which is the origin its CORS is scoped to. `apps/web`
reads `VITE_API_URL` (default `http://localhost:3000`). **The two must agree** —
a mismatch fails as a browser CORS rejection rather than an obvious error.

`VITE_API_URL` is inlined by Vite at build time into both the server and browser
bundles, so SSR cannot use an internal address distinct from the browser's, and
changing it needs a rebuild rather than a restart.

## How the frontend gets its data

`apps/web/src/atoms/NotesApi.ts` builds an `AtomHttpApi` client from the *same*
`Api` the server implements, imported as `@{{name}}/api/api`. Renaming an
endpoint or changing a schema is a compile error in the UI as well as the server.

That client hands back atoms: `notesList` is a query atom holding an
`AsyncResult`, and `createNote` is a mutation. The React hooks come from
`@effect/atom-react` — note the scope, since `@effect-atom/atom-react` is an
older standalone package that targets effect v3 and cannot read
`effect/unstable/reactivity` atoms.

Rendering is server-side, with the data carried across:

1. `getRouter()` creates an `AtomRegistry` — **per request**, since a
   module-level one would leak one visitor's data into another's render.
2. The route loader fills it before rendering, so the markup ships with data.
3. `Hydration.dehydrate` serializes it into the HTML payload.
4. `Hydration.hydrate` restores it on the client before first paint.

So the first paint has the list already, with no loading flash and no refetch on
mount. `notesList` carries a `serializationKey` because that is the identity the
handoff uses; without one the atom is not serializable, dehydration skips it, and
the app silently degrades into a client-side refetch while looking perfectly
correct. The test in `apps/web/src/atoms/` is what guards that.

## Adding an endpoint

1. Declare it in `apps/api/src/api/Notes.ts`.
2. Implement it in `apps/api/src/server/Notes/http.ts` — the handler list is
   type-checked against the declaration, so a missing handler will not compile.

The frontend picks the change up through `@{{name}}/api/api` with no extra step.

## Tests

```bash
cd apps/api && {{runCmd}} test    # the API, through real routing and decoding
cd apps/web && {{runCmd}} test    # the SSR hydration round-trip
```

`apps/api` uses `HttpApiTest.groups`, which runs the real request encoding,
routing and response decoding against the handlers with no server and no port.

`apps/web` has two tests, both about the thing that fails silently: that a
dehydrated atom rehydrates without issuing a second request, and that the shipped
atom really is serializable.

## A note on `reactivityKeys`

Mutations normally invalidate queries by reactivity key. `notesList` deliberately
does not use them: in effect `4.0.0-rc.112`, combining `reactivityKeys` with
`serializationKey` breaks the hydration preload, so the first client read
refetches anyway — reintroducing exactly what hydration exists to avoid. The list
is refreshed explicitly after a successful mutation instead. The comment in
`apps/web/src/atoms/NotesApi.ts` says how to retest it after an effect upgrade.
