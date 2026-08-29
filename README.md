# create-effect-project

Scaffolds an Effect v4 project on Node or Bun.

```bash
npx create-effect-project
npx create-effect-project --name my-api --template http-server --runtime bun
npx create-effect-project --name my-app --template basic --runtime node --no-otel --no-lint
```

Omit `--name`, `--template`, `--runtime`, or `--pm` (for node) and you are prompted; supply them
and nothing prompts, so the same binary works in CI and in a terminal.

Whichever package manager you pick is used for the install *and* for the commands the generated
files document — a project installed with pnpm is documented `pnpm run dev`, not `npm run dev`.

## Templates

| `--template` | What you get |
| --- | --- |
| `http-server` | A schema-first `HttpApi`: one definition produces the server routes, an OpenAPI document at `/openapi.json`, Scalar docs at `/docs`, and a typed client checked against the server at compile time |
| `fullstack` | The same `HttpApi` behind **both** a server and a server-rendered React UI: a workspace where `apps/web` (TanStack Start) drives its data through Effect's own reactivity, hydrated from SSR |
| `basic` | A runnable program — a `Context.Service` with an in-memory layer, a branded id, a typed error, and a `main` that handles it. No server |
| `alchemy-http` | The **same** `HttpApi`, deployed to a Cloudflare Worker with [Alchemy](https://alchemy.run) — infrastructure as Effects, no `wrangler.toml` |
| `alchemy-rpc` | The same Notes service exposed as typed **RPC** on a Worker — typed errors cross the wire as themselves, no status codes |

All five get the same optional features and both runtimes. No build step: Node and Bun execute
TypeScript directly — except `fullstack`'s web app, which Vite builds.

Four of them serve the same Notes domain. `domain/Note.ts` and `server/Notes.ts` come from
`templates/_shared/notes/` and are emitted byte-identically by all four — under `src/` for the
single-package templates and under `apps/api/src/` for `fullstack` — so the business logic is one
file and only the transport adapter differs. `http-server` and `alchemy-http` go
further and share the whole `HttpApi` surface from `templates/_shared/httpapi/`; their only
difference is the entrypoint:

```ts
// http-server: bind the routes to a port
HttpRouter.serve(AllRoutes).pipe(Layer.provide(NodeHttpServer.layerConfig(createServer, { port })))

// alchemy-http: convert the same routes to a Worker fetch handler
HttpRouter.toHttpEffect(AllRoutes).pipe(Effect.provide(HttpServer.layerServices))
```

`alchemy-rpc` swaps that entrypoint for an `RpcGroup`: no paths, verbs or status codes, and
`NoteNotFound` reaches the client as itself rather than as a 404 to interpret. What you give up is
everything that comes from being ordinary HTTP — no OpenAPI document, no Scalar page, no `curl`.

For both alchemy templates, `--runtime` still applies but selects what runs the deploy script and
the client demo — the Worker itself always targets workerd. `--otel` does **not** apply: OTLP from
inside an isolate is the wrong shape for Cloudflare, so the CLI warns rather than wiring up
telemetry that would not work. Cloudflare's own observability and `alchemy tail` are the answer
there.

**What CI does not cover:** `alchemy deploy` needs a Cloudflare account, so the e2e stops at the
deploy boundary for both alchemy templates. Install, typecheck, lint and the API/RPC tests are
verified; the deploy path is not.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--name`, `-n` | prompted | Directory and package name |
| `--template`, `-t` | prompted | `http-server`, `basic`, `alchemy-http` or `alchemy-rpc` |
| `--runtime` | prompted | `node` or `bun` |
| `--pm` | prompted (node) | `npm`, `pnpm`, `yarn`, `bun`. Node projects are asked, with the detected manager pre-selected; bun projects use bun. Pass it to skip the prompt |
| `--no-otel` | on | Skip OTLP logs/metrics/traces wiring |
| `--no-lint` | on | Skip oxlint + `@effect/tsgo` language service |
| `--slop` | off | Add stricter oxlint rules that reject sloppy code (needs `--lint`) |
| `--no-install` | installs | Skip dependency installation |
| `--no-git` | initialises | Skip `git init` |

## `--slop`

oxlint has no "slop" category — its seven are `correctness`, `suspicious`, `pedantic`, `perf`,
`style`, `restriction` and `nursery`, and there is no oxlint slop plugin on npm. So `--slop` is a
**curated rule list**, not a category, merged into the generated `.oxlintrc.json`.

Curated rather than a category because the broad categories are actively hostile to Effect code.
Turning on `pedantic` + `style` + `restriction` flags `_tag` (`no-underscore-dangle`), every
`function*()` (`func-names`), and wants `Users.test.ts` renamed to `users.test.ts`
(`filename-case`) — dozens of findings, none of them slop.

What the curated list targets is code that papers over problems or was never finished:

| | |
| --- | --- |
| Type escapes | `no-explicit-any`, `ban-ts-comment`, `no-non-null-assertion`, `no-non-null-asserted-nullish-coalescing` |
| Empty shells | `no-empty`, `no-empty-function`, `no-empty-interface`, `no-empty-object-type` |
| Dead weight | `no-useless-return`, `no-useless-computed-key`, `no-else-return`, `no-lonely-if`, `no-duplicate-imports`, and the `unicorn/no-useless-*` family |
| Left-behind debugging | `no-console` |
| Wrong async | `require-await`, `unicorn/no-await-expression-member` |

`no-duplicate-imports` is set with `allowSeparateTypeImports: true` — a separate `import type` is
correct under `verbatimModuleSyntax`, not duplication.

The e2e proves both halves: the generated code lints clean with the rules on, a deliberately sloppy
file is rejected, and **the same file passes once the rules are removed** — so the findings come
from `--slop` rather than the base `correctness` set. Without that last control the config could be
inert and every other assertion would still pass.

`--slop` without `--lint` warns instead of silently doing nothing: the rules are a patch onto the
config `--lint` writes, so there would be nothing to patch.

## Adding a template

`src/Template.ts` is the only file that needs to know a template exists:

1. Add a directory under `templates/`, with a `runtime/node/` and `runtime/bun/` subtree for
   whatever differs between the two (the entrypoint and the test framework, usually).
2. Add its id to `Template.ids` and a `Template` value to `Template.all`. The `Record<Id, Template>`
   makes a missing entry a type error.
3. List its files in the template's `files` table, ending with `...sharedFiles`, and set
   `patches: sharedPatches`. Add `...observabilityFiles` if `--otel` applies (and set
   `supportsOtel` to match — a test enforces that they agree, *and* that something actually
   imports the layer). Add `...notesFiles` to reuse the shared domain and service, or
   `...httpApiFiles` for the whole HTTP surface on top of it.

Optional features come for free: `_shared/features/` supplies the observability layer and the
oxlint config to every template on identical terms, so `--otel` and `--no-lint` need no per-template
handling. The tests then check the new template automatically — they iterate `Template.ids` and
assert every template emits a manifest, a tsconfig, a README and next steps, references only files
that exist, and never writes two sources to one path.

## Publishing

The published package is a **bundle**, not the TypeScript sources. That is not a preference —
Node refuses to strip types for any file under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) at every version, so a package whose `bin` points
at a `.ts` file cannot run via `npx` no matter what `engines` says.

```bash
npm run build       # esbuild -> dist/bin.js, one file, no runtime dependencies
npm run test:pack   # packs the tarball, installs it as a consumer, runs the binary
```

`effect` and `@effect/platform-node` are `devDependencies` on purpose: they are bundled into
`dist/bin.js`, so a consumer installs **zero** runtime dependencies. Unbundled that install was
77 MB and pulled in native prebuild machinery; bundled it is 2.2 MB and under a second.

Two details the bundle depends on, both pinned by `npm run test:pack`:

- **No shebang banner.** esbuild already preserves the entry point's, so adding one produces two
  and the file will not parse.
- **A `createRequire` shim is required.** `@effect/platform-node` pulls in `undici`, which is CJS
  and calls `require`; without the banner the bundle dies at startup with
  `Dynamic require of "node:assert" is not supported`.

To release: bump `version`, push an annotated `v<version>` tag, and `.github/workflows/release.yml`
publishes with npm provenance after re-running the full suite. It refuses to publish if the tag
disagrees with `package.json` or if the version already exists. `workflow_dispatch` runs the same
job as a dry run. The workflow needs an `NPM_TOKEN` secret.

## CI

`.github/workflows/ci.yml` runs typecheck, the unit suite, the packaged-install smoke test, and
the end-to-end test on every push
to `main` and every pull request. The e2e scaffolds, installs and runs a real project for every
template × runtime combination, lints it, and additionally covers `--slop` on node.
The alchemy templates stop at the deploy boundary, as noted above. Bun is
installed in CI on purpose: without it the bun cases would skip, leaving the run green while
covering only node — so the workflow asserts on the reporter's structured counts that all five
cases actually ran.

## Development

```bash
npm test           # fast suite, fake filesystem
npm run test:pack  # builds, packs, installs the tarball and runs the binary
npm run test:e2e   # scaffolds, installs and runs real projects (slow)
npm run typecheck
npm run build      # dist/bin.js
```
