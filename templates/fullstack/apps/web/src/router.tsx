import { RegistryContext } from "@effect/atom-react"
import { createRouter } from "@tanstack/react-router"
import { Schema } from "effect"
import { AtomRegistry, Hydration } from "effect/unstable/reactivity"
import { routeTree } from "./routeTree.gen"

export interface RouterContext {
  readonly registry: AtomRegistry.AtomRegistry
}

// The dehydrated envelope, as a schema rather than a cast. `JSON.parse` returns
// `any`, and asserting a type onto it would only silence the compiler — this
// decodes, so the shape that actually crossed the SSR boundary is checked.
// `value` stays `Unknown` because it varies per atom; `Hydration.hydrate` hands
// it to that atom's own decoder.
const DehydratedAtoms = Schema.Array(Schema.Struct({
  "~effect/reactivity/DehydratedAtom": Schema.Literal(true),
  key: Schema.String,
  value: Schema.Unknown,
  dehydratedAt: Schema.Finite
}))

const decodeAtoms = Schema.decodeUnknownSync(DehydratedAtoms)

export function getRouter() {
  // One registry per call. On the server `getRouter` runs per request, so this
  // is the isolation boundary that keeps one visitor's data out of another's
  // render; on the client it runs once.
  const registry = AtomRegistry.make()

  return createRouter({
    routeTree,
    scrollRestoration: true,
    context: { registry } satisfies RouterContext,
    // Runs on the server after rendering: encodes every serializable atom into
    // the payload TanStack Start injects into the HTML.
    //
    // The atoms are serialized to a string rather than handed over as objects.
    // Start validates this return type at compile time and rejects any property
    // typed `unknown`, since it cannot prove it JSON-safe — and
    // `Hydration.DehydratedAtomValue.value` is `unknown` by design, because its
    // shape varies per atom. Its contents come from `Schema.encodeSync`, so they
    // are genuinely JSON-safe; a string says so in a way the type system can
    // check, which beats widening the return to `any` and asserting it.
    dehydrate: () => ({ atoms: JSON.stringify(Hydration.toValues(Hydration.dehydrate(registry))) }),
    // Runs on the client before the first render, so the atoms are already
    // Success by the time any component reads them.
    hydrate: (dehydrated: { readonly atoms: string }) => {
      Hydration.hydrate(registry, decodeAtoms(JSON.parse(dehydrated.atoms)))
    },
    // `@effect/atom-react`'s own `RegistryProvider` builds a registry from
    // options, but ours has to be the per-request one created above — so the
    // context is provided directly.
    Wrap: ({ children }: { readonly children: React.ReactNode }) => (
      <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
    )
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
