import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import { InstallFailed, PackageManagerMissing } from "../src/Errors.ts"
import { Git } from "../src/Git.ts"
import { PackageManager } from "../src/PackageManager.ts"
import * as Project from "../src/Project.ts"
import * as Template from "../src/Template.ts"

const permissionDenied = PlatformError.systemError({
  _tag: "PermissionDenied",
  module: "FileSystem",
  method: "writeFileString",
  description: "EACCES"
})

interface Journal {
  readonly removed: Array<string>
  readonly created: Array<string>
  readonly installs: Array<readonly [string, string]>
  readonly gitInits: Array<string>
}

const harness = (overrides: {
  readonly exists?: boolean
  readonly emptyDir?: boolean
  readonly failWrite?: boolean
  readonly failInstall?: boolean
  readonly missingManager?: boolean
} = {}) => {
  const journal: Journal = { removed: [], created: [], installs: [], gitInits: [] }
  const written = new Map<string, string>()

  const fsLayer = FileSystem.layerNoop({
    exists: () => Effect.succeed(overrides.exists ?? false),
    readDirectory: () => Effect.succeed(overrides.emptyDir === false ? ["something"] : []),
    makeDirectory: () => Effect.void,
    readFileString: (path) => {
      const already = written.get(path as string)
      return Effect.succeed(already ?? `{"scripts":{},"devDependencies":{}}`)
    },
    writeFileString: (path, data) =>
      overrides.failWrite === true
        ? Effect.fail(permissionDenied)
        : Effect.sync(() => {
          written.set(path as string, data)
          journal.created.push(path as string)
        }),
    remove: (path) => Effect.sync(() => { journal.removed.push(path as string) })
  })

  const pmLayer = Layer.succeed(PackageManager, PackageManager.of({
    install: (cwd, manager) => {
      if (overrides.missingManager === true) {
        return Effect.fail(new PackageManagerMissing({ packageManager: manager, cause: new Error("ENOENT") }))
      }
      return overrides.failInstall === true
        ? Effect.fail(new InstallFailed({ packageManager: manager, exitCode: 1 }))
        : Effect.sync(() => { journal.installs.push([cwd, manager] as const) })
    }
  }))

  const gitLayer = Layer.succeed(Git, Git.of({
    init: (cwd) => Effect.sync(() => { journal.gitInits.push(cwd) })
  }))

  return { journal, layer: Layer.mergeAll(fsLayer, Path.layer, pmLayer, gitLayer) }
}

const options: Project.ScaffoldOptions = {
  name: "my-api",
  directory: "/out/my-api",
  templateRoot: "/pkg/templates",
  template: Template.httpServer,
  selection: { runtime: "node", otel: true, lint: true, slop: false, packageManager: "pnpm" },
  packageManager: "pnpm",
  install: true,
  git: true
}

describe("Project.scaffold", () => {
  it.effect("renders, installs and initialises git", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      const result = yield* Project.scaffold(options)
      assert.isNotEmpty(result.files)
      assert.isTrue(result.dependenciesInstalled)
      assert.deepStrictEqual(journal.installs, [["/out/my-api", "pnpm"] as const])
      assert.deepStrictEqual(journal.gitInits, ["/out/my-api"])
      assert.deepStrictEqual(journal.removed, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses a non-empty target and writes nothing", () => {
    const { journal, layer } = harness({ exists: true, emptyDir: false })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(Project.scaffold(options))
      assert.strictEqual(error._tag, "TargetNotEmpty")
      assert.deepStrictEqual(journal.created, [])
      assert.deepStrictEqual(journal.removed, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("accepts an existing empty directory", () => {
    const { journal, layer } = harness({ exists: true, emptyDir: true })
    return Effect.gen(function*() {
      yield* Project.scaffold(options)
      assert.strictEqual(journal.installs.length, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("removes a directory it created when rendering fails", () => {
    const { journal, layer } = harness({ failWrite: true })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(Project.scaffold(options))
      assert.strictEqual(error._tag, "TemplateWriteFailed")
      assert.deepStrictEqual(journal.removed, ["/out/my-api"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps a pre-existing directory when rendering fails", () => {
    const { journal, layer } = harness({ exists: true, emptyDir: true, failWrite: true })
    return Effect.gen(function*() {
      yield* Effect.flip(Project.scaffold(options))
      assert.deepStrictEqual(journal.removed, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("survives a failed install, keeps the project and reports it uninstalled", () => {
    const { journal, layer } = harness({ failInstall: true })
    return Effect.gen(function*() {
      const result = yield* Project.scaffold(options)
      assert.isNotEmpty(result.files)
      assert.isFalse(result.dependenciesInstalled)
      assert.deepStrictEqual(journal.removed, [])
      assert.deepStrictEqual(journal.gitInits, ["/out/my-api"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("survives a missing package manager and reports it uninstalled", () => {
    const { journal, layer } = harness({ missingManager: true })
    return Effect.gen(function*() {
      const result = yield* Project.scaffold(options)
      assert.isNotEmpty(result.files)
      assert.isFalse(result.dependenciesInstalled)
      assert.deepStrictEqual(journal.removed, [])
      assert.deepStrictEqual(journal.gitInits, ["/out/my-api"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("skips install and git when asked", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      const result = yield* Project.scaffold({ ...options, install: false, git: false })
      assert.isFalse(result.dependenciesInstalled)
      assert.deepStrictEqual(journal.installs, [])
      assert.deepStrictEqual(journal.gitInits, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("renders whichever template it is given", () => {
    // Regression pin: the template used to be hardcoded inside scaffold, so
    // --template could have been accepted and silently ignored.
    const { layer } = harness()
    return Effect.gen(function*() {
      const result = yield* Project.scaffold({ ...options, template: Template.basic })
      assert.include(result.files, "src/main.ts")
      assert.include(result.files, "src/Users.ts")
      assert.notInclude(result.files, "src/index.ts")
      assert.notInclude(result.files, "src/api/Api.ts")
    }).pipe(Effect.provide(layer))
  })

  it.effect("passes the selection through to the renderer", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      const result = yield* Project.scaffold({
        ...options,
        selection: { runtime: "bun", otel: false, lint: false, slop: false, packageManager: "bun" }
      })
      assert.include(result.files, "src/index.ts")
      assert.notInclude(result.files, ".oxlintrc.json")
      assert.isNotEmpty(journal.created)
    }).pipe(Effect.provide(layer))
  })
})
