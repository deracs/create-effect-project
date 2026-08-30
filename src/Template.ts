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
export const ids = [
  "http-server",
  "fullstack",
  "basic",
  "cli",
  "ai",
  "alchemy-http",
  "alchemy-rpc"
] as const

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

/**
 * Re-roots a file list under a subdirectory of the generated project. Lets a
 * workspace template reuse the same shared sources as the single-package ones,
 * emitting them at `apps/api/src/...` instead of `src/...`, so the Notes domain
 * stays byte-identical across every template that serves it.
 */
const under = (base: string, files: ReadonlyArray<TemplateFile>): ReadonlyArray<TemplateFile> =>
  files.map((file) => ({ ...file, to: `${base}/${file.to}` }))

/** Files every template receives, whatever it targets. */
const sharedFiles: ReadonlyArray<TemplateFile> = [
  { from: "_shared/_gitignore", to: ".gitignore", substitute: false },
  {
    from: "_shared/features/_oxlintrc.json",
    to: ".oxlintrc.json",
    substitute: false,
    when: (selection) => selection.lint
  },
  // Points the editor at the workspace TypeScript. Without it VS Code runs its
  // own bundled copy, which loads no plugins — so the language service the lint
  // feature installs would be silent in the editor while `typecheck` still
  // reported its diagnostics. Gated on `lint` because that is what installs it.
  {
    from: "_shared/features/_vscode.settings.json",
    to: ".vscode/settings.json",
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
  { from: "_shared/notes/Notes.ts", to: "src/server/Notes.ts", substitute: false }
]

/**
 * `port` and `baseUrl` — only for templates that actually open or call a socket.
 * Not part of `notesFiles`, because `cli` and `ai` reach the same service
 * in-process and would otherwise emit a config file nothing imports.
 */
const socketConfigFile: TemplateFile = {
  from: "_shared/config.ts",
  to: "src/config.ts",
  substitute: false
}

/**
 * The HTTP face of the Notes domain: one schema-first `HttpApi` definition, its
 * handlers, and the client derived from it. Shared because it is the same API
 * whether it is bound to a port or converted to a Worker fetch handler.
 */
const httpApiFiles: ReadonlyArray<TemplateFile> = [
  ...notesFiles,
  socketConfigFile,
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
 * The API half of the full-stack template: the same sources `http-server`
 * emits, minus the two files that genuinely differ. `server/http.ts` and
 * `config.ts` are template-owned here because this server has a browser on
 * another origin talking to it, so it needs CORS and an origin to scope it to —
 * which a standalone API has no reason to carry.
 */
const fullstackApiFiles: ReadonlyArray<TemplateFile> = [
  { from: "_shared/notes/domain/Note.ts", to: "src/domain/Note.ts", substitute: false },
  { from: "_shared/notes/Notes.ts", to: "src/server/Notes.ts", substitute: false },
  { from: "_shared/httpapi/api/Api.ts", to: "src/api/Api.ts", substitute: false },
  { from: "_shared/httpapi/api/System.ts", to: "src/api/System.ts", substitute: false },
  { from: "_shared/httpapi/api/Notes.ts", to: "src/api/Notes.ts", substitute: false },
  { from: "_shared/httpapi/server/Notes/http.ts", to: "src/server/Notes/http.ts", substitute: false },
  { from: "_shared/httpapi/client/ApiClient.ts", to: "src/client/ApiClient.ts", substitute: false },
  { from: "fullstack/apps/api/http.ts", to: "src/server/http.ts", substitute: false },
  { from: "fullstack/apps/api/config.ts", to: "src/config.ts", substitute: false }
]

/**
 * The web half: a TanStack Start app whose data comes from `AtomHttpApi` atoms
 * built on the very same `Api` the server implements, server-rendered and
 * hydrated so the first paint carries its data.
 */
const fullstackWebFiles: ReadonlyArray<TemplateFile> = [
  { from: "fullstack/apps/web/vite.config.ts", to: "vite.config.ts", substitute: false },
  { from: "fullstack/apps/web/src/router.tsx", to: "src/router.tsx", substitute: false },
  { from: "fullstack/apps/web/src/styles.css", to: "src/styles.css", substitute: false },
  { from: "fullstack/apps/web/src/routes/__root.tsx", to: "src/routes/__root.tsx", substitute: false },
  { from: "fullstack/apps/web/src/routes/index.tsx", to: "src/routes/index.tsx", substitute: false },
  // Substituted: imports the API definition as `@{{name}}/api/api`.
  { from: "fullstack/apps/web/src/atoms/NotesApi.ts", to: "src/atoms/NotesApi.ts", substitute: true }
]

/**
 * One `HttpApi` definition behind both a server and a browser. The frontend
 * imports it through the API package's `exports`, so the contract is checked at
 * compile time on both sides, and its data comes from Effect's own reactivity
 * rather than a separate fetching library.
 *
 * A workspace rather than one package, because the two halves need genuinely
 * different TypeScript configuration — `types: ["bun"]` against
 * `lib: ["DOM"]` — and cannot share a manifest.
 */
export const fullstack: Template = {
  id: "fullstack",
  title: "Full-stack — the same HttpApi with a server-rendered React UI",
  description: "An HttpApi server plus a TanStack Start frontend driven by Effect atoms",
  supportsOtel: true,
  files: [
    // Workspace root.
    { from: "fullstack/_package.json", to: "package.json", substitute: true },
    { from: "fullstack/_tsconfig.json", to: "tsconfig.json", substitute: false },
    { from: "fullstack/README.md", to: "README.md", substitute: true },
    { from: "fullstack/_gitignore", to: ".gitignore", substitute: false },
    // npm, yarn and bun read `workspaces` from the root manifest; pnpm needs its
    // own file and ignores that field.
    {
      from: "fullstack/_pnpm-workspace.yaml",
      to: "pnpm-workspace.yaml",
      substitute: false,
      when: (selection) => selection.packageManager === "pnpm"
    },

    ...under("apps/api", fullstackApiFiles),
    ...under("apps/api", observabilityFiles),
    ...under("apps/web", fullstackWebFiles),

    // The API entrypoint, client demo and handler test are the same as
    // `http-server`'s — the server does not change because a browser talks to it.
    ...under("apps/api", [
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

      // Manifests and tsconfigs are template-owned: this API is a workspace
      // member with an `exports` entry, not a standalone project.
      {
        from: "fullstack/apps/api/runtime/node/_package.json",
        to: "package.json",
        substitute: true,
        when: forRuntime("node")
      },
      {
        from: "fullstack/apps/api/runtime/node/_tsconfig.json",
        to: "tsconfig.json",
        substitute: false,
        when: forRuntime("node")
      },
      {
        from: "fullstack/apps/api/runtime/bun/_package.json",
        to: "package.json",
        substitute: true,
        when: forRuntime("bun")
      },
      {
        from: "fullstack/apps/api/runtime/bun/_tsconfig.json",
        to: "tsconfig.json",
        substitute: false,
        when: forRuntime("bun")
      }
    ]),

    // The web app differs by runtime only in its test runner: `bun:test` under
    // bun, vitest under node.
    ...under("apps/web", [
      {
        from: "fullstack/apps/web/runtime/node/NotesApi.test.ts",
        to: "src/atoms/NotesApi.test.ts",
        substitute: true,
        when: forRuntime("node")
      },
      {
        from: "fullstack/apps/web/runtime/node/_package.json",
        to: "package.json",
        substitute: true,
        when: forRuntime("node")
      },
      {
        from: "fullstack/apps/web/runtime/node/_tsconfig.json",
        to: "tsconfig.json",
        substitute: false,
        when: forRuntime("node")
      },
      {
        from: "fullstack/apps/web/runtime/bun/NotesApi.test.ts",
        to: "src/atoms/NotesApi.test.ts",
        substitute: true,
        when: forRuntime("bun")
      },
      {
        from: "fullstack/apps/web/runtime/bun/_package.json",
        to: "package.json",
        substitute: true,
        when: forRuntime("bun")
      },
      {
        from: "fullstack/apps/web/runtime/bun/_tsconfig.json",
        to: "tsconfig.json",
        substitute: false,
        when: forRuntime("bun")
      }
    ]),

    {
      from: "_shared/features/_oxlintrc.json",
      to: ".oxlintrc.json",
      substitute: false,
      when: (selection) => selection.lint
    },
    // As in `sharedFiles`: the workspace root is where the editor looks, and
    // where the hoisted TypeScript lives.
    {
      from: "_shared/features/_vscode.settings.json",
      to: ".vscode/settings.json",
      substitute: false,
      when: (selection) => selection.lint
    }
  ],
  // The shared lint patch scripts `oxlint src`, which is not where the sources
  // live here — this one lints `apps` instead. Otherwise identical.
  patches: [
    { from: "fullstack/lint.package.json", to: "package.json", when: (s) => s.lint },
    { from: "_shared/features/lint.tsconfig.json", to: "tsconfig.json", when: (s) => s.lint },
    { from: "_shared/features/slop.oxlintrc.json", to: ".oxlintrc.json", when: (s) => s.lint && s.slop }
  ],
  nextSteps: (selection) => [
    `cd apps/api && ${runCmd(selection.packageManager)} dev   # http://localhost:3000/docs`,
    `cd apps/web && ${runCmd(selection.packageManager)} dev   # http://localhost:3001`
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
 * The same Notes service as the server templates, driven from `argv` instead of
 * a port. Carries a second implementation of that service — file-backed rather
 * than in-memory — because a CLI exits between commands and a `Map` would not
 * survive the gap.
 */
export const cli: Template = {
  id: "cli",
  title: "CLI — subcommands, prompts and typed errors over the Notes service",
  description: "A command-line app: subcommands, arguments, flags, prompts and exit codes",
  supportsOtel: true,
  files: [
    ...notesFiles,
    { from: "cli/src/commands.ts", to: "src/commands.ts", substitute: true },
    { from: "cli/src/NotesFile.ts", to: "src/NotesFile.ts", substitute: false },
    { from: "cli/README.md", to: "README.md", substitute: true },

    // Runtime-specific: the runner, and the test framework (`@effect/vitest`
    // under node, `bun:test` under bun).
    { from: "cli/runtime/node/main.ts", to: "src/main.ts", substitute: true, when: forRuntime("node") },
    {
      from: "cli/runtime/node/NotesFile.test.ts",
      to: "src/NotesFile.test.ts",
      substitute: false,
      when: forRuntime("node")
    },
    {
      from: "cli/runtime/node/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "cli/runtime/node/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("node")
    },
    { from: "cli/runtime/bun/main.ts", to: "src/main.ts", substitute: true, when: forRuntime("bun") },
    {
      from: "cli/runtime/bun/NotesFile.test.ts",
      to: "src/NotesFile.test.ts",
      substitute: false,
      when: forRuntime("bun")
    },
    {
      from: "cli/runtime/bun/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "cli/runtime/bun/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("bun")
    },

    ...observabilityFiles,
    ...sharedFiles
  ],
  patches: sharedPatches,
  nextSteps: (selection) => [
    `${runCmd(selection.packageManager)} dev -- add "Buy milk" --body "2 litres"`,
    `${runCmd(selection.packageManager)} dev -- list`,
    `${runCmd(selection.packageManager)} dev -- --help`,
    `${runCmd(selection.packageManager)} test`
  ]
}

/**
 * The same Notes service again, this time handed to a language model as tools.
 * `LanguageModel` is the seam: the toolkit and the program name it and never
 * name a provider, so Anthropic and OpenAI are one file apart — and a stub in
 * the tests is a third implementation of the same interface, which is why they
 * need no API key.
 */
export const ai: Template = {
  id: "ai",
  title: "AI — a language model calling the Notes service as typed tools",
  description: "A language model with typed tools, on Anthropic or OpenAI",
  supportsOtel: true,
  files: [
    ...notesFiles,
    { from: "ai/src/AiModel.ts", to: "src/AiModel.ts", substitute: true },
    { from: "ai/src/NotesToolkit.ts", to: "src/NotesToolkit.ts", substitute: false },
    { from: "ai/README.md", to: "README.md", substitute: true },

    // Runtime-specific: the runner, and the test framework (`@effect/vitest`
    // under node, `bun:test` under bun).
    { from: "ai/runtime/node/main.ts", to: "src/main.ts", substitute: true, when: forRuntime("node") },
    {
      from: "ai/runtime/node/NotesToolkit.test.ts",
      to: "src/NotesToolkit.test.ts",
      substitute: false,
      when: forRuntime("node")
    },
    {
      from: "ai/runtime/node/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("node")
    },
    {
      from: "ai/runtime/node/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("node")
    },
    { from: "ai/runtime/bun/main.ts", to: "src/main.ts", substitute: true, when: forRuntime("bun") },
    {
      from: "ai/runtime/bun/NotesToolkit.test.ts",
      to: "src/NotesToolkit.test.ts",
      substitute: false,
      when: forRuntime("bun")
    },
    {
      from: "ai/runtime/bun/_package.json",
      to: "package.json",
      substitute: true,
      when: forRuntime("bun")
    },
    {
      from: "ai/runtime/bun/_tsconfig.json",
      to: "tsconfig.json",
      substitute: false,
      when: forRuntime("bun")
    },

    ...observabilityFiles,
    ...sharedFiles
  ],
  patches: sharedPatches,
  nextSteps: (selection) => [
    "export ANTHROPIC_API_KEY=sk-...   # or OPENAI_API_KEY with AI_PROVIDER=openai",
    `${runCmd(selection.packageManager)} start`,
    `${runCmd(selection.packageManager)} start -- "what notes do I have?"`,
    `${runCmd(selection.packageManager)} test      # no key needed`
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
    // The RPC client reads `baseUrl` to reach the deployed Worker.
    socketConfigFile,
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
  fullstack,
  basic,
  cli,
  ai,
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
        // Workspace members are depended on by name. npm resolves that from the
        // manifest's `workspaces` field and does not understand the `workspace:`
        // protocol; the other three do, and are explicit about it.
        .replaceAll(
          "{{workspaceVersion}}",
          options.selection.packageManager === "npm" ? "*" : "workspace:*"
        )

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
