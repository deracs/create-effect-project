import { Effect, FileSystem, Path } from "effect"
import { fileURLToPath } from "node:url"
import { TemplateWriteFailed } from "./Errors.ts"

export const runtimes = ["node", "bun"] as const

export type Runtime = typeof runtimes[number]

/**
 * The templates on offer, in the order the CLI presents them. The first is the
 * prompt's default.
 *
 * Adding one is a directory under `templates/`, an entry here, and an entry in
 * `all` — optional features and both runtimes then apply to it unchanged.
 */
export const ids = ["http-server", "basic", "alchemy-http", "alchemy-rpc"] as const

export type Id = typeof ids[number]

export interface Selection {
  readonly runtime: Runtime
  readonly otel: boolean
  readonly lint: boolean
  /**
   * Stricter oxlint rules aimed at sloppy and machine-generated code. Only
   * meaningful with `lint`, since it patches the oxlint config that `lint`
   * writes.
   */
  readonly slop: boolean
  /**
   * Drives `{{runCmd}}` in generated files. It belongs here because it changes
   * emitted content: a project installed with pnpm should be documented with
   * `pnpm run`, not `npm run`.
   */
  readonly packageManager: string
}

export interface TemplateFile {
  /**
   * Path within `templates/`, underscore-prefixed where needed. Rooted at
   * `templates/` rather than at the template's own directory so a template can
   * pull in `_shared/` assets.
   */
  readonly from: string
  /** Path within the generated project. */
  readonly to: string
  /** Whether `{{name}}` and `{{runCmd}}` are replaced in this file. */
  readonly substitute: boolean
  /** Omitted means always included. */
  readonly when?: (selection: Selection) => boolean
}

export interface TemplatePatch {
  /** A partial JSON document merged into an already-written target. */
  readonly from: string
  readonly to: string
  readonly when: (selection: Selection) => boolean
}

export interface Template {
  readonly id: Id
  /** Shown in the `--template` prompt. */
  readonly title: string
  readonly description: string
  /**
   * Whether `--otel` means anything here. False for targets where OTLP export
   * from inside the process is the wrong shape — a Cloudflare Worker wants
   * tail workers, not an exporter in the isolate. The CLI warns rather than
   * accepting a flag it would ignore.
   */
  readonly supportsOtel: boolean
  readonly files: ReadonlyArray<TemplateFile>
  readonly patches: ReadonlyArray<TemplatePatch>
  /**
   * What to tell the user to run once the project is on disk. Each template owns
   * its own, because a non-server project has no `client` script and no `/docs`
   * to open.
   */
  readonly nextSteps: (selection: Selection) => ReadonlyArray<string>
}

const forRuntime = (runtime: Runtime) => (selection: Selection) => selection.runtime === runtime

/** Files every template receives, whatever it targets. */
const sharedFiles: ReadonlyArray<TemplateFile> = [
  { from: "_shared/_gitignore", to: ".gitignore", substitute: false },
  {
    from: "_shared/features/_oxlintrc.json",
    to: ".oxlintrc.json",
    substitute: false,
    when: (selection) => selection.lint
  }
]

/**
 * Exactly one `observability.ts` is emitted, so an entrypoint needs no
 * per-feature variant. Only for templates with `supportsOtel: true`.
 */
const observabilityFiles: ReadonlyArray<TemplateFile> = [
  {
    from: "_shared/features/observability.otel.ts",
    to: "src/observability.ts",
    substitute: true,
    when: (selection) => selection.otel
  },
  {
    from: "_shared/features/observability.noop.ts",
    to: "src/observability.ts",
    substitute: false,
    when: (selection) => !selection.otel
  }
]

/**
 * The Notes domain and the service that implements it. Transport-agnostic: the
 * service knows nothing about HTTP or RPC, so every template that serves Notes
 * gets identical business logic and differs only in its adapter.
 */
const notesFiles: ReadonlyArray<TemplateFile> = [
  { from: "_shared/notes/domain/Note.ts", to: "src/domain/Note.ts", substitute: false },
  { from: "_shared/notes/Notes.ts", to: "src/server/Notes.ts", substitute: false },
  { from: "_shared/config.ts", to: "src/config.ts", substitute: false }
]

/**
 * The HTTP face of the Notes domain: one schema-first `HttpApi` definition, its
 * handlers, and the client derived from it. Shared because it is the same API
 * whether it is bound to a port or converted to a Worker fetch handler.
 */
const httpApiFiles: ReadonlyArray<TemplateFile> = [
  ...notesFiles,
  { from: "_shared/httpapi/api/Api.ts", to: "src/api/Api.ts", substitute: false },
  { from: "_shared/httpapi/api/System.ts", to: "src/api/System.ts", substitute: false },
  { from: "_shared/httpapi/api/Notes.ts", to: "src/api/Notes.ts", substitute: false },
  { from: "_shared/httpapi/server/http.ts", to: "src/server/http.ts", substitute: false },
  { from: "_shared/httpapi/server/Notes/http.ts", to: "src/server/Notes/http.ts", substitute: false },
  { from: "_shared/httpapi/client/ApiClient.ts", to: "src/client/ApiClient.ts", substitute: false }
]

/**
 * Patches every template receives. Applied after all files are written, so they
 * merge into a manifest and tsconfig that already exist.
 */
const sharedPatches: ReadonlyArray<TemplatePatch> = [
  { from: "_shared/features/lint.package.json", to: "package.json", when: (s) => s.lint },
  { from: "_shared/features/lint.tsconfig.json", to: "tsconfig.json", when: (s) => s.lint },
  // Merged into the oxlint config `lint` already wrote, so `slop` alone emits
  // nothing — there would be no config to patch.
  { from: "_shared/features/slop.oxlintrc.json", to: ".oxlintrc.json", when: (s) => s.lint && s.slop }
]

/**
 * The tables are explicit rather than a directory walk: adding a template file
 * is a deliberate edit, and the render tests can assert the exact emitted set.
 */
export const httpServer: Template = {
  id: "http-server",
  title: "HTTP server — schema-first HttpApi with a typed client",
  description: "A schema-first HttpApi server with a typed client",
  supportsOtel: true,
  files: [
    ...httpApiFiles,
    { from: "http-server/README.md", to: "README.md", substitute: true },

    // Runtime-specific.
    {
      from: "http-server/runtime/node/index.ts",
      to: "src/index.ts",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "http-server/runtime/node/client.ts",
      to: "src/client.ts",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "http-server/runtime/node/http.test.ts",
      to: "src/server/Notes/http.test.ts",
      substitute: false,
      when: forRuntime("node")
    },
    {
      from: "http-server/runtime/node/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "http-server/runtime/node/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("node")
    },
    {
      from: "http-server/runtime/bun/index.ts",
      to: "src/index.ts",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "http-server/runtime/bun/client.ts",
      to: "src/client.ts",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "http-server/runtime/bun/http.test.ts",
      to: "src/server/Notes/http.test.ts",
      substitute: false,
      when: forRuntime("bun")
    },
    {
      from: "http-server/runtime/bun/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "http-server/runtime/bun/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("bun")
    },

    ...observabilityFiles,
    ...sharedFiles
  ],
  patches: sharedPatches,
  nextSteps: (selection) => [
    `${runCmd(selection.packageManager)} dev      # then open http://localhost:3000/docs`,
    `${runCmd(selection.packageManager)} client   # in another terminal`
  ]
}

/**
 * A runnable program rather than a server: a service, a typed error, and a
 * `main` that handles the failure itself instead of letting `HttpApi` map it to
 * a status code.
 */
export const basic: Template = {
  id: "basic",
  title: "Basic app — a runnable program with a service and a typed error",
  description: "A plain Effect program: a Context.Service, a typed error, and a main",
  supportsOtel: true,
  files: [
    // Runtime-invariant sources.
    { from: "basic/src/domain/User.ts", to: "src/domain/User.ts", substitute: false },
    { from: "basic/src/Users.ts", to: "src/Users.ts", substitute: false },
    { from: "basic/README.md", to: "README.md", substitute: true },

    // Runtime-specific: the runner, and the test framework (`@effect/vitest`
    // under node, `bun:test` under bun).
    { from: "basic/runtime/node/main.ts", to: "src/main.ts", substitute: true, when: forRuntime("node") },
    {
      from: "basic/runtime/node/Users.test.ts",
      to: "src/Users.test.ts",
      substitute: false,
      when: forRuntime("node")
    },
    {
      from: "basic/runtime/node/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "basic/runtime/node/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("node")
    },
    { from: "basic/runtime/bun/main.ts", to: "src/main.ts", substitute: true, when: forRuntime("bun") },
    {
      from: "basic/runtime/bun/Users.test.ts",
      to: "src/Users.test.ts",
      substitute: false,
      when: forRuntime("bun")
    },
    {
      from: "basic/runtime/bun/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "basic/runtime/bun/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("bun")
    },

    ...observabilityFiles,
    ...sharedFiles
  ],
  patches: sharedPatches,
  nextSteps: (selection) => [
    `${runCmd(selection.packageManager)} dev      # runs src/main.ts`,
    `${runCmd(selection.packageManager)} test`
  ]
}

/**
 * The same HttpApi as `http-server`, deployed to a Cloudflare Worker with
 * Alchemy instead of bound to a port. `--runtime` still applies, but it selects
 * what runs the deploy script and the client demo — the Worker itself always
 * targets workerd.
 */
export const alchemyHttp: Template = {
  id: "alchemy-http",
  title: "Alchemy HTTP — the same HttpApi on a Cloudflare Worker",
  description: "A schema-first HttpApi deployed to Cloudflare with Alchemy",
  // OTLP from inside a Worker isolate is the wrong shape; Cloudflare wants tail
  // workers. The README says so, and the CLI warns instead of ignoring --otel.
  supportsOtel: false,
  files: [
    ...httpApiFiles,
    { from: "alchemy-http/src/worker.ts", to: "src/worker.ts", substitute: true },
    { from: "alchemy-http/alchemy.run.ts", to: "alchemy.run.ts", substitute: true },
    { from: "alchemy-http/README.md", to: "README.md", substitute: true },

    // Runtime-specific: the deploy driver and the test framework, not the Worker.
    {
      from: "alchemy-http/runtime/node/client.ts",
      to: "src/client.ts",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "alchemy-http/runtime/node/http.test.ts",
      to: "src/server/Notes/http.test.ts",
      substitute: false,
      when: forRuntime("node")
    },
    {
      from: "alchemy-http/runtime/node/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "alchemy-http/runtime/node/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("node")
    },
    {
      from: "alchemy-http/runtime/bun/client.ts",
      to: "src/client.ts",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "alchemy-http/runtime/bun/http.test.ts",
      to: "src/server/Notes/http.test.ts",
      substitute: false,
      when: forRuntime("bun")
    },
    {
      from: "alchemy-http/runtime/bun/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "alchemy-http/runtime/bun/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("bun")
    },

    ...sharedFiles
  ],
  patches: sharedPatches,
  nextSteps: (selection) => [
    `npx alchemy login          # once, connects your Cloudflare account`,
    `${runCmd(selection.packageManager)} deploy    # prints the Worker URL`,
    `${runCmd(selection.packageManager)} test      # no account needed`
  ]
}

/**
 * The same Notes service as the HTTP templates, exposed as RPC instead. The
 * contract replaces the `HttpApi`; the domain and the service are unchanged.
 */
export const alchemyRpc: Template = {
  id: "alchemy-rpc",
  title: "Alchemy RPC — a typed RPC service on a Cloudflare Worker",
  description: "An Effect RPC group deployed to Cloudflare with Alchemy",
  // Same reasoning as alchemy-http: a Worker isolate is the wrong place for an
  // OTLP exporter, and it cannot be verified without deploying.
  supportsOtel: false,
  files: [
    ...notesFiles,
    { from: "alchemy-rpc/src/rpc.ts", to: "src/rpc.ts", substitute: false },
    { from: "alchemy-rpc/src/server/Notes/rpc.ts", to: "src/server/Notes/rpc.ts", substitute: false },
    { from: "alchemy-rpc/src/worker.ts", to: "src/worker.ts", substitute: true },
    { from: "alchemy-rpc/alchemy.run.ts", to: "alchemy.run.ts", substitute: true },
    { from: "alchemy-rpc/README.md", to: "README.md", substitute: true },

    // Runtime-specific: the deploy driver and the test framework, not the Worker.
    {
      from: "alchemy-rpc/runtime/node/client.ts",
      to: "src/client.ts",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "alchemy-rpc/runtime/node/rpc.test.ts",
      to: "src/server/Notes/rpc.test.ts",
      substitute: false,
      when: forRuntime("node")
    },
    {
      from: "alchemy-rpc/runtime/node/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "alchemy-rpc/runtime/node/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("node")
    },
    {
      from: "alchemy-rpc/runtime/bun/client.ts",
      to: "src/client.ts",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "alchemy-rpc/runtime/bun/rpc.test.ts",
      to: "src/server/Notes/rpc.test.ts",
      substitute: false,
      when: forRuntime("bun")
    },
    {
      from: "alchemy-rpc/runtime/bun/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "alchemy-rpc/runtime/bun/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("bun")
    },

    ...sharedFiles
  ],
  patches: sharedPatches,
  nextSteps: (selection) => [
    `npx alchemy login          # once, connects your Cloudflare account`,
    `${runCmd(selection.packageManager)} deploy    # prints the Worker URL`,
    `${runCmd(selection.packageManager)} test      # no account needed`
  ]
}

/**
 * Keyed by id so a new entry in `ids` without a template here is a type error
 * rather than a runtime surprise.
 */
export const all: Record<Id, Template> = {
  "http-server": httpServer,
  basic,
  "alchemy-http": alchemyHttp,
  "alchemy-rpc": alchemyRpc
}

export const byId = (id: Id): Template => all[id]

/** Resolves the shipped `templates/` directory relative to a module's URL. */
export const templateRoot = (moduleUrl: string): string =>
  fileURLToPath(new URL("../templates", moduleUrl))

/**
 * The command prefix for the project's scripts. Derived from the package
 * manager rather than the runtime, so a pnpm project is documented with
 * `pnpm run`. `<pm> run <script>` is valid for all four managers.
 */
export const runCmd = (packageManager: string): string => `${packageManager} run`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Deep-merges a patch into a base JSON value. Objects merge recursively; arrays
 * and scalars are replaced by the patch. Used to fold optional-feature
 * dependencies and scripts into an already-rendered manifest or tsconfig.
 */
const mergeJson = (base: unknown, patch: unknown): unknown => {
  if (!isRecord(base) || !isRecord(patch)) return patch
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? mergeJson(base[key], value) : value
  }
  return out
}

export const render = (options: {
  readonly template: Template
  readonly sourceRoot: string
  readonly targetDir: string
  readonly projectName: string
  readonly selection: Selection
}): Effect.Effect<
  ReadonlyArray<string>,
  TemplateWriteFailed,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const written: Array<string> = []

    const substitute = (raw: string): string =>
      raw
        .replaceAll("{{name}}", options.projectName)
        .replaceAll("{{runCmd}}", runCmd(options.selection.packageManager))

    for (const file of options.template.files) {
      if (file.when !== undefined && !file.when(options.selection)) continue

      const to = path.join(options.targetDir, file.to)

      const raw = yield* fs.readFileString(path.join(options.sourceRoot, file.from)).pipe(
        Effect.mapError((cause) => new TemplateWriteFailed({ path: file.from, cause }))
      )
      yield* fs.makeDirectory(path.dirname(to), { recursive: true }).pipe(
        Effect.mapError((cause) => new TemplateWriteFailed({ path: file.to, cause }))
      )
      yield* fs.writeFileString(to, file.substitute ? substitute(raw) : raw).pipe(
        Effect.mapError((cause) => new TemplateWriteFailed({ path: file.to, cause }))
      )
      written.push(file.to)
    }

    for (const patch of options.template.patches) {
      if (!patch.when(options.selection)) continue

      const to = path.join(options.targetDir, patch.to)

      const patchRaw = yield* fs.readFileString(path.join(options.sourceRoot, patch.from)).pipe(
        Effect.mapError((cause) => new TemplateWriteFailed({ path: patch.from, cause }))
      )
      const baseRaw = yield* fs.readFileString(to).pipe(
        Effect.mapError((cause) => new TemplateWriteFailed({ path: patch.to, cause }))
      )

      const merged = yield* Effect.try({
        try: () => mergeJson(JSON.parse(baseRaw), JSON.parse(patchRaw)),
        catch: (cause) => new TemplateWriteFailed({ path: patch.to, cause })
      })

      yield* fs.writeFileString(to, `${JSON.stringify(merged, null, 2)}\n`).pipe(
        Effect.mapError((cause) => new TemplateWriteFailed({ path: patch.to, cause }))
      )
    }

    return written
  })
