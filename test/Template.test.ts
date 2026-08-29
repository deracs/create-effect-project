import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import * as Template from "../src/Template.ts"

const permissionDenied = PlatformError.systemError({
  _tag: "PermissionDenied",
  module: "FileSystem",
  method: "writeFileString",
  description: "EACCES"
})

interface Recorder {
  readonly writes: Array<readonly [string, string]>
}

/** Records writes and serves reads back, so patches can be observed merging. */
const recordingFs = (contents: Record<string, string>) => {
  const rec: Recorder = { writes: [] }
  const written = new Map<string, string>()
  const layer = Layer.mergeAll(
    FileSystem.layerNoop({
      makeDirectory: () => Effect.void,
      writeFileString: (path, data) =>
        Effect.sync(() => {
          written.set(path as string, data)
          rec.writes.push([path as string, data] as const)
        }),
      readFileString: (path) => {
        const key = path as string
        const already = written.get(key)
        if (already !== undefined) return Effect.succeed(already)
        const seeded = contents[key]
        return seeded === undefined
          ? Effect.die(new Error(`unexpected read: ${key}`))
          : Effect.succeed(seeded)
      }
    }),
    Path.layer
  )
  return { rec, layer, written }
}

const sourceRoot = "/pkg/templates"

/** Lists every file under `dir`, relative to `root`, recursively. */
const walk = (dir: string, root: string): Array<string> => {
  const out: Array<string> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, root))
    } else {
      out.push(relative(root, full))
    }
  }
  return out
}

const sources = (template: Template.Template): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const file of template.files) {
    out[`${sourceRoot}/${file.from}`] = file.from.endsWith(".json")
      ? `{"name":"{{name}}","scripts":{"dev":"x"}}`
      : `contents of ${file.from} for {{name}} via {{runCmd}}`
  }
  // Patches serve their REAL content from disk. A patch is a small JSON document
  // whose content is the entire behaviour under test — a synthetic stub would
  // make the merge assertions vacuous. Files stay synthetic: they are large
  // TypeScript sources whose content the renderer never inspects.
  for (const patch of template.patches) {
    out[`${sourceRoot}/${patch.from}`] = readFileSync(
      join(fileURLToPath(new URL("../templates", import.meta.url)), patch.from),
      "utf8"
    )
  }
  return out
}

const selection = (over: Partial<Template.Selection> = {}): Template.Selection => ({
  runtime: "node",
  otel: true,
  lint: true,
  slop: false,
  packageManager: "npm",
  ...over
})

const run = (
  over: Partial<Template.Selection> = {},
  template: Template.Template = Template.httpServer
) => {
  const harness = recordingFs(sources(template))
  const effect = Template.render({
    template,
    sourceRoot,
    targetDir: "/out",
    projectName: "my-api",
    selection: selection(over)
  }).pipe(Effect.provide(harness.layer))
  return { harness, effect }
}

describe("Template.render", () => {
  it.effect("renames underscore-prefixed config files", () => {
    const { effect } = run()
    return Effect.gen(function*() {
      const written = yield* effect
      assert.include(written, "package.json")
      assert.include(written, "tsconfig.json")
      assert.include(written, ".gitignore")
      assert.notInclude(written, "_package.json")
      assert.notInclude(written, "_gitignore")
    })
  })

  it.effect("selects the node runtime files and no bun files", () => {
    const { effect } = run({ runtime: "node" })
    return Effect.gen(function*() {
      const written = yield* effect
      assert.include(written, "src/index.ts")
      assert.include(written, "src/client.ts")
      assert.include(written, "src/server/Notes/http.test.ts")
      for (const path of written) assert.notInclude(path, "runtime/")
    })
  })

  it.effect("emits exactly one observability.ts, chosen by the otel flag", () => {
    const { effect } = run({ otel: true })
    return Effect.gen(function*() {
      const written = yield* effect
      const matches = written.filter((p) => p.endsWith("src/observability.ts"))
      assert.strictEqual(matches.length, 1)
    })
  })

  it.effect("emits observability.ts even with otel off", () => {
    const { effect } = run({ otel: false })
    return Effect.gen(function*() {
      const written = yield* effect
      assert.strictEqual(written.filter((p) => p.endsWith("src/observability.ts")).length, 1)
    })
  })

  it.effect("includes .oxlintrc.json only when lint is on", () => {
    const on = run({ lint: true })
    const off = run({ lint: false })
    return Effect.gen(function*() {
      assert.include(yield* on.effect, ".oxlintrc.json")
      assert.notInclude(yield* off.effect, ".oxlintrc.json")
    })
  })

  it.effect("merges the lint patch into package.json when lint is on", () => {
    const { harness, effect } = run({ lint: true })
    return Effect.gen(function*() {
      yield* effect
      const manifest = JSON.parse(harness.written.get("/out/package.json") ?? "{}")
      assert.strictEqual(manifest.scripts.lint, "oxlint src")
      assert.strictEqual(manifest.devDependencies.oxlint, "1.80.0")
      // the base manifest's own keys survive the merge
      assert.strictEqual(manifest.scripts.dev, "x")
      assert.strictEqual(manifest.name, "my-api")
    })
  })

  it.effect("leaves package.json unpatched when lint is off", () => {
    const { harness, effect } = run({ lint: false })
    return Effect.gen(function*() {
      yield* effect
      const manifest = JSON.parse(harness.written.get("/out/package.json") ?? "{}")
      assert.isUndefined(manifest.scripts?.lint)
      assert.isUndefined(manifest.devDependencies?.oxlint)
    })
  })

  it.effect("substitutes name and runCmd, leaving no placeholders in substituted files", () => {
    // Only files marked `substitute: true` (README.md, package.json) get placeholders
    // replaced; the fixture seeds placeholder text into every file's synthetic
    // content, so this must be scoped to the substituted targets, not all writes.
    const { harness, effect } = run({ runtime: "bun", packageManager: "bun" })
    const substitutedTargets = new Set(
      Template.httpServer.files.filter((file) => file.substitute).map((file) => file.to)
    )
    return Effect.gen(function*() {
      yield* effect
      for (const [path, data] of harness.rec.writes) {
        if (!substitutedTargets.has(path.replace("/out/", ""))) continue
        assert.notInclude(data, "{{name}}")
        assert.notInclude(data, "{{runCmd}}")
      }
      const readme = harness.written.get("/out/README.md") ?? ""
      assert.include(readme, "bun run")
    })
  })

  it.effect("documents the project with the chosen package manager, not the runtime", () => {
    // A node project installed with pnpm must be documented `pnpm run dev`.
    // Deriving runCmd from the runtime would wrongly say `npm run`.
    const { harness, effect } = run({ runtime: "node", packageManager: "pnpm" })
    return Effect.gen(function*() {
      yield* effect
      const readme = harness.written.get("/out/README.md") ?? ""
      assert.include(readme, "pnpm run")
      assert.notInclude(readme, "npm run dev")
    })
  })

  it.effect("fails with TemplateWriteFailed when a write is refused", () => {
    const layer = Layer.mergeAll(
      FileSystem.layerNoop({
        makeDirectory: () => Effect.void,
        readFileString: () => Effect.succeed("contents"),
        writeFileString: () => Effect.fail(permissionDenied)
      }),
      Path.layer
    )
    return Effect.gen(function*() {
      const error = yield* Effect.flip(Template.render({
        template: Template.httpServer,
        sourceRoot,
        targetDir: "/out",
        projectName: "my-api",
        selection: selection()
      }))
      assert.strictEqual(error._tag, "TemplateWriteFailed")
    }).pipe(Effect.provide(layer))
  })

  it.effect("renders the basic template: a program, a service, no server files", () => {
    const { effect } = run({}, Template.basic)
    return Effect.gen(function*() {
      const written = yield* effect
      assert.include(written, "src/main.ts")
      assert.include(written, "src/Users.ts")
      assert.include(written, "src/domain/User.ts")
      assert.include(written, "src/Users.test.ts")
      assert.include(written, "package.json")
      assert.include(written, "src/observability.ts")
      // A basic project has no HTTP surface at all.
      assert.notInclude(written, "src/index.ts")
      assert.notInclude(written, "src/client.ts")
      assert.notInclude(written, "src/api/Api.ts")
    })
  })

  it.effect("merges the slop rules into the oxlint config when --slop is on", () => {
    const { harness, effect } = run({ lint: true, slop: true })
    return Effect.gen(function*() {
      yield* effect
      const config = JSON.parse(harness.written.get("/out/.oxlintrc.json") ?? "{}")
      assert.strictEqual(config.rules?.["typescript/no-explicit-any"], "error")
      assert.strictEqual(config.rules?.["no-console"], "error")
    })
  })

  it.effect("leaves the oxlint config unpatched when --slop is off", () => {
    const { harness, effect } = run({ lint: true, slop: false })
    return Effect.gen(function*() {
      yield* effect
      const config = JSON.parse(harness.written.get("/out/.oxlintrc.json") ?? "{}")
      assert.isUndefined(config.rules)
    })
  })

  it.effect("adds nothing for --slop without --lint, rather than writing a stray config", () => {
    // There is no oxlint config to patch, so the patch must not fire — applying
    // it would fail on a missing file, or worse, create one oxlint never reads.
    const { harness, effect } = run({ lint: false, slop: true })
    return Effect.gen(function*() {
      const written = yield* effect
      assert.notInclude(written, ".oxlintrc.json")
      assert.isUndefined(harness.written.get("/out/.oxlintrc.json"))
    })
  })

  it.effect("renders alchemy-http: the shared HttpApi plus a Worker, no local server", () => {
    const { effect } = run({}, Template.alchemyHttp)
    return Effect.gen(function*() {
      const written = yield* effect
      // The same API surface as http-server, file for file.
      for (const shared of [
        "src/api/Api.ts",
        "src/domain/Note.ts",
        "src/server/http.ts",
        "src/server/Notes/http.ts",
        "src/client/ApiClient.ts",
        "src/server/Notes/http.test.ts"
      ]) {
        assert.include(written, shared, `alchemy-http did not emit ${shared}`)
      }
      // ...but a Worker and a stack rather than a port-bound entrypoint.
      assert.include(written, "src/worker.ts")
      assert.include(written, "alchemy.run.ts")
      assert.notInclude(written, "src/index.ts")
      // Declines otel, so no stub nothing imports.
      assert.notInclude(written, "src/observability.ts")
    })
  })

  it("emits an identical HttpApi surface for http-server and alchemy-http", () => {
    // The two templates exist to show one API definition against two targets.
    // If their shared surface ever diverges, that claim is false.
    const surface = (template: Template.Template) =>
      template.files
        .filter((file) => file.from.startsWith("_shared/httpapi/"))
        .map((file) => `${file.from} -> ${file.to}`)
        .sort()

    assert.deepStrictEqual(surface(Template.httpServer), surface(Template.alchemyHttp))
    assert.isNotEmpty(surface(Template.httpServer))
  })

  it("gives every Notes template the same domain and service, at the same paths", () => {
    // The claim across all three Notes templates: identical business logic,
    // different transport adapter. HTTP or RPC, `src/server/Notes.ts` is one
    // file — if a template started carrying its own copy, that breaks.
    const notes = (template: Template.Template) =>
      template.files
        .filter((file) => file.from.startsWith("_shared/notes/"))
        .map((file) => `${file.from} -> ${file.to}`)
        .sort()

    const templates = [
      Template.httpServer,
      Template.alchemyHttp,
      Template.alchemyRpc
    ]
    for (const template of templates) {
      assert.isNotEmpty(notes(template), `${template.id} shares no Notes sources`)
      assert.deepStrictEqual(
        notes(template),
        notes(Template.httpServer),
        `${template.id} does not share the Notes domain and service`
      )
    }
    // `basic` is not a Notes template and must not pick them up.
    assert.isEmpty(notes(Template.basic))
  })

  it.effect("renders alchemy-rpc: a contract and handlers, no HttpApi", () => {
    const { effect } = run({}, Template.alchemyRpc)
    return Effect.gen(function*() {
      const written = yield* effect
      assert.include(written, "src/rpc.ts")
      assert.include(written, "src/server/Notes/rpc.ts")
      assert.include(written, "src/server/Notes/rpc.test.ts")
      assert.include(written, "src/worker.ts")
      assert.include(written, "alchemy.run.ts")
      // The same domain and service as the HTTP templates.
      assert.include(written, "src/domain/Note.ts")
      assert.include(written, "src/server/Notes.ts")
      // ...but no HTTP surface: no HttpApi, no derived client, no Scalar docs.
      assert.notInclude(written, "src/api/Api.ts")
      assert.notInclude(written, "src/server/http.ts")
      assert.notInclude(written, "src/client/ApiClient.ts")
      assert.notInclude(written, "src/index.ts")
      assert.notInclude(written, "src/observability.ts")
    })
  })

  it.effect("gives every template the shared optional features on the same terms", () => {
    // The point of `_shared/`: otel and lint are not per-template behaviour.
    return Effect.gen(function*() {
      for (const id of Template.ids) {
        const template = Template.byId(id)
        const on = yield* run({ otel: true, lint: true }, template).effect
        const off = yield* run({ otel: false, lint: false }, template).effect

        // A template that declines otel must emit no observability.ts at all —
        // an unimported stub is worse than nothing.
        const expected = template.supportsOtel ? 1 : 0
        assert.strictEqual(
          on.filter((p) => p.endsWith("src/observability.ts")).length,
          expected,
          `${id} (supportsOtel=${template.supportsOtel}) emitted the wrong number of observability.ts with otel on`
        )
        assert.strictEqual(
          off.filter((p) => p.endsWith("src/observability.ts")).length,
          expected,
          `${id} (supportsOtel=${template.supportsOtel}) emitted the wrong number of observability.ts with otel off`
        )
        assert.include(on, ".oxlintrc.json", `${id} did not emit .oxlintrc.json with lint on`)
        assert.notInclude(off, ".oxlintrc.json", `${id} emitted .oxlintrc.json with lint off`)
      }
    })
  })
})

describe("Template registry", () => {
  it("exposes a template for every id, keyed consistently", () => {
    for (const id of Template.ids) {
      assert.strictEqual(Template.byId(id).id, id, `all["${id}"] has a mismatched id`)
    }
    assert.strictEqual(Object.keys(Template.all).length, Template.ids.length)
  })

  it("gives every template a name, package.json, tsconfig and next steps", () => {
    // A template that emits no manifest cannot be installed, and one with no
    // next steps leaves the user at a prompt with nothing to type.
    for (const id of Template.ids) {
      const template = Template.byId(id)
      assert.isNotEmpty(template.title, `${id} has no title`)
      assert.isNotEmpty(template.description, `${id} has no description`)
      for (const runtime of Template.runtimes) {
        const emitted = new Set(
          template.files
            .filter((file) => file.when === undefined || file.when(selection({ runtime })))
            .map((file) => file.to)
        )
        assert.isTrue(emitted.has("package.json"), `${id}/${runtime} emits no package.json`)
        assert.isTrue(emitted.has("tsconfig.json"), `${id}/${runtime} emits no tsconfig.json`)
        assert.isTrue(emitted.has("README.md"), `${id}/${runtime} emits no README.md`)
        assert.isNotEmpty(
          template.nextSteps(selection({ runtime })),
          `${id}/${runtime} offers no next steps`
        )
      }
    }
  })

  it("keeps supportsOtel honest against the files and the entrypoints", () => {
    // The flag is a promise to the user. It must match both what is emitted and
    // whether anything actually imports it — the earlier bug in this repo was an
    // --otel that was wired nowhere.
    const templatesDir = fileURLToPath(new URL("../templates", import.meta.url))
    for (const id of Template.ids) {
      const template = Template.byId(id)
      const emitted = template.files
        .filter((file) => file.when === undefined || file.when(selection({ otel: true })))
        .map((file) => file.to)
      assert.strictEqual(
        emitted.some((path) => path.endsWith("src/observability.ts")),
        template.supportsOtel,
        `${id} claims supportsOtel=${template.supportsOtel} but emits observability.ts=${
          emitted.some((path) => path.endsWith("src/observability.ts"))
        }`
      )

      // If it is emitted, something must import it.
      if (!template.supportsOtel) continue
      const imports = template.files.some((file) => {
        if (file.to === "src/observability.ts") return false
        const full = join(templatesDir, file.from)
        return existsSync(full) && readFileSync(full, "utf8").includes("Observability.layer")
      })
      assert.isTrue(imports, `${id} emits observability.ts but no file provides Observability.layer`)
    }
  })

  it("never emits two different sources to the same path for one selection", () => {
    // Two files with overlapping `when` predicates would silently overwrite each
    // other, and which one won would depend on table order.
    for (const id of Template.ids) {
      const template = Template.byId(id)
      for (const runtime of Template.runtimes) {
        for (const otel of [true, false]) {
          for (const lint of [true, false]) {
            for (const slop of [true, false]) {
            const current = selection({ runtime, otel, lint, slop })
            const seen = new Map<string, string>()
            for (const file of template.files) {
              if (file.when !== undefined && !file.when(current)) continue
              const previous = seen.get(file.to)
              assert.isUndefined(
                previous,
                `${id}/${runtime} otel=${otel} lint=${lint}: both ${previous} and ${file.from} write ${file.to}`
              )
              seen.set(file.to, file.from)
            }
            }
          }
        }
      }
    }
  })
})

describe("Template tables against the tree on disk", () => {
  const templatesDir = fileURLToPath(new URL("../templates", import.meta.url))

  const allEntries = () =>
    Template.ids.flatMap((id) => {
      const template = Template.byId(id)
      return [
        ...template.files.map((file) => ({ id, from: file.from, substitute: file.substitute })),
        ...template.patches.map((patch) => ({ id, from: patch.from, substitute: false }))
      ]
    })

  it("references only files that exist", () => {
    for (const entry of allEntries()) {
      assert.isTrue(
        existsSync(join(templatesDir, entry.from)),
        `${entry.id} references ${entry.from}, which is not on disk`
      )
    }
  })

it("installs every TypeScript plugin the lint patch registers", () => {
    // `lint.tsconfig.json` registers @effect/language-service as a plugin, but a
    // plugin only loads if something actually depends on it — and a plugin that
    // resolves to nothing fails silently: the editor simply shows no Effect
    // diagnostics. Nothing else catches this. `typecheck` stays green because
    // `effect-tsgo patch` patches tsc itself, so the CLI, the e2e and every
    // generated test suite pass either way.
    const lintOn = selection({ lint: true })

    for (const id of Template.ids) {
      const template = Template.byId(id)
      const patchFor = (target: string) =>
        template.patches.find((patch) => patch.to === target && patch.when(lintOn))

      const tsconfigPatch = patchFor("tsconfig.json")
      const manifestPatch = patchFor("package.json")
      assert.isDefined(tsconfigPatch, `${id} has no lint patch for tsconfig.json`)
      assert.isDefined(manifestPatch, `${id} has no lint patch for package.json`)

      const tsconfig = JSON.parse(readFileSync(join(templatesDir, tsconfigPatch!.from), "utf8"))
      const manifest = JSON.parse(readFileSync(join(templatesDir, manifestPatch!.from), "utf8"))

      const plugins: ReadonlyArray<{ name: string }> = tsconfig.compilerOptions?.plugins ?? []
      assert.isNotEmpty(plugins, `${id}: ${tsconfigPatch!.from} registers no plugins`)

      for (const plugin of plugins) {
        assert.isDefined(
          manifest.devDependencies?.[plugin.name],
          `${id} registers the TypeScript plugin ${plugin.name} in ${tsconfigPatch!.from} but ` +
            `${manifestPatch!.from} does not depend on it, so it will resolve to nothing`
        )
      }
    }
  })

  it("leaves no file on disk unreferenced", () => {
    // Catches the reverse of the above: a template file added to the tree but
    // never wired into a table would be shipped and never emitted.
    const referenced = new Set(allEntries().map((entry) => entry.from))
    for (const relPath of walk(templatesDir, templatesDir)) {
      assert.isTrue(
        referenced.has(relPath),
        `${relPath} is on disk but no template references it`
      )
    }
  })

  it("marks every file with a placeholder substitute:true, and vice versa", () => {
    // Reads the real tree (not a fixture) so this catches the case a real
    // template file gains a placeholder but isn't flagged, or a flag is set on
    // a file that doesn't need it.
    const hasPlaceholder = (relPath: string): boolean => {
      const contents = readFileSync(join(templatesDir, relPath), "utf8")
      return contents.includes("{{name}}") || contents.includes("{{runCmd}}")
    }

    const substituteByFrom = new Map<string, boolean>()
    for (const entry of allEntries()) {
      // A shared file is referenced by several templates; they must agree.
      const previous = substituteByFrom.get(entry.from)
      if (previous !== undefined) {
        assert.strictEqual(
          previous,
          entry.substitute,
          `${entry.from} is marked substitute inconsistently across templates`
        )
      }
      substituteByFrom.set(entry.from, entry.substitute)
    }

    for (const relPath of walk(templatesDir, templatesDir)) {
      if (!hasPlaceholder(relPath)) continue
      assert.isTrue(
        substituteByFrom.get(relPath) === true,
        `${relPath} contains a placeholder but is not marked substitute: true`
      )
    }

    for (const [from, substitute] of substituteByFrom) {
      if (!substitute) continue
      assert.isTrue(
        hasPlaceholder(from),
        `${from} is marked substitute: true but contains no placeholder`
      )
    }
  })

  it("provides the observability layer from every runtime entrypoint", () => {
    // Regression pin: --otel was once wired into the demo client but never into
    // the generated server, because nothing asserted the entrypoints actually
    // provide `Observability.layer(...)`. Read the real files: a fixture's
    // synthetic content would pass regardless of what the template says.
    const entrypoints = [
      "http-server/runtime/node/index.ts",
      "http-server/runtime/bun/index.ts",
      "basic/runtime/node/main.ts",
      "basic/runtime/bun/main.ts"
    ]
    for (const entrypoint of entrypoints) {
      const contents = readFileSync(join(templatesDir, entrypoint), "utf8")
      assert.include(
        contents,
        "Observability.layer",
        `${entrypoint} does not provide Observability.layer`
      )
    }
  })

  it("keeps the two basic entrypoints identical apart from the runtime", () => {
    // The node and bun `main.ts` differ only in which runMain they call. They
    // will drift unless something says so.
    const normalise = (relPath: string) =>
      readFileSync(join(templatesDir, relPath), "utf8")
        .replace(/import \{ (Node|Bun)Runtime \} from "@effect\/platform-(node|bun)"\n/, "")
        .replace(/(Node|Bun)Runtime\.runMain/, "runMain")

    assert.strictEqual(
      normalise("basic/runtime/node/main.ts"),
      normalise("basic/runtime/bun/main.ts"),
      "basic node and bun main.ts have drifted beyond their runtime lines"
    )
  })
})
