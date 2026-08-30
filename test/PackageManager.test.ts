import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, PlatformError, Sink, Stdio, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as PackageManager from "../src/PackageManager.ts"

describe("PackageManager.parseUserAgent", () => {
  it("reads the manager from real user agents", () => {
    assert.strictEqual(
      PackageManager.parseUserAgent("pnpm/8.15.0 npm/? node/v22.22.2 darwin arm64"),
      "pnpm"
    )
    assert.strictEqual(PackageManager.parseUserAgent("npm/10.8.0 node/v22.22.2 darwin arm64"), "npm")
    assert.strictEqual(PackageManager.parseUserAgent("yarn/4.1.0 npm/? node/v22.22.2 darwin arm64"), "yarn")
    assert.strictEqual(PackageManager.parseUserAgent("bun/1.3.14 npm/? node/v22.22.2 darwin arm64"), "bun")
  })

  it("defaults to npm for absent or unrecognised agents", () => {
    assert.strictEqual(PackageManager.parseUserAgent(undefined), "npm")
    assert.strictEqual(PackageManager.parseUserAgent(""), "npm")
    assert.strictEqual(PackageManager.parseUserAgent("deno/1.0.0"), "npm")
    assert.strictEqual(PackageManager.parseUserAgent("garbage"), "npm")
  })
})

describe("PackageManager.forRuntime", () => {
  it("pins bun projects to bun and leaves node projects to detection", () => {
    assert.strictEqual(PackageManager.forRuntime("bun"), "bun")
    assert.isUndefined(PackageManager.forRuntime("node"))
  })
})

describe("PackageManager.detect", () => {
  it.effect("detects from the environment through a ConfigProvider", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* PackageManager.detect, "pnpm")
    }).pipe(
      Effect.provide(ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          npm_config_user_agent: "pnpm/8.15.0 npm/? node/v22.22.2 darwin arm64"
        })
      ))
    ))

  it.effect("falls back to npm when the key is absent", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* PackageManager.detect, "npm")
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))))
})

describe("PackageManager.install", () => {
  /** A spawner whose `exitCode` is fixed, with everything else left unused. */
  const spawnerWith = (
    exitCode: ChildProcessSpawner.ChildProcessSpawner["Service"]["exitCode"]
  ) =>
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
      ...ChildProcessSpawner.make(() => Effect.die("unused")),
      exitCode
    })

  const run = <A, E>(
    exitCode: ChildProcessSpawner.ChildProcessSpawner["Service"]["exitCode"],
    use: (pm: PackageManager.PackageManager["Service"]) => Effect.Effect<A, E>
  ) =>
    Effect.flatMap(PackageManager.PackageManager, use).pipe(
      Effect.provide(PackageManager.PackageManager.layer.pipe(
        Layer.provide(spawnerWith(exitCode)),
        // The layer reads `Stdio` so it can route the manager's output to stderr
        // when stdout is reserved; these cases never take that branch.
        Layer.provide(Stdio.layerTest({}))
      ))
    )

  it.effect("succeeds on exit 0", () =>
    run(() => Effect.succeed(ChildProcessSpawner.ExitCode(0)), (pm) => pm.install("/out/my-api", "npm")))

  it.effect("reports a non-zero exit as InstallFailed, carrying the code", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        run(() => Effect.succeed(ChildProcessSpawner.ExitCode(7)), (pm) => pm.install("/out/my-api", "npm"))
      )
      assert.strictEqual(error._tag, "InstallFailed")
      assert.strictEqual(error._tag === "InstallFailed" ? error.exitCode : undefined, 7)
    }))

  /**
   * A handle whose stdout emits `chunks`, standing in for a package manager
   * printing progress. Everything else is unused: these tests are about where
   * that output lands, not about process control.
   */
  const handleEmitting = (chunks: ReadonlyArray<string>) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.fromArray(chunks.map((chunk) => new TextEncoder().encode(chunk))),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.die("unused")
    })

  /**
   * Captures the spawned commands and what reaches the two output streams, so a
   * test can say where the manager's own output went rather than which spawn
   * option was passed.
   */
  const capturing = (chunks: ReadonlyArray<string> = []) => {
    const commands: Array<ChildProcess.Command> = []
    const stderr: Array<string> = []
    const stdout: Array<string> = []
    const sink = (into: Array<string>) =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          into.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
        })
      )
    const layer = PackageManager.PackageManager.layer.pipe(
      Layer.provide(Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            commands.push(command)
            return handleEmitting(chunks)
          })
        )
      )),
      Layer.provide(Stdio.layerTest({
        stdout: () => sink(stdout),
        stderr: () => sink(stderr)
      }))
    )
    return { commands, stderr, stdout, layer }
  }

  // Under `--print-dir` the shell is capturing stdout to get the project path.
  // A package manager writing progress there would end up inside the `cd`
  // argument. It still has to be visible, though — a silent minute looks like a
  // hang, which is the whole reason 0.2.0 started showing it.
  it.effect("routes the manager's own output to stderr when stdout is reserved", () =>
    Effect.gen(function*() {
      const { layer, stderr, stdout } = capturing(["added 42 packages\n"])
      yield* Effect.flatMap(
        PackageManager.PackageManager,
        (pm) => pm.install("/out/my-api", "npm", { stdout: "stderr" })
      ).pipe(Effect.provide(layer))
      assert.include(stderr.join(""), "added 42 packages")
      assert.deepStrictEqual(stdout, [])
    }))

  it.effect("inherits the terminal by default, so the output is the manager's own", () =>
    Effect.gen(function*() {
      const { layer, commands } = capturing()
      yield* Effect.flatMap(
        PackageManager.PackageManager,
        (pm) => pm.install("/out/my-api", "npm")
      ).pipe(Effect.provide(layer))
      // "inherit" hands the child the real file descriptors, so there is no
      // stream to observe — the spawn option is the only visible evidence.
      assert.strictEqual(
        commands[0]?._tag === "StandardCommand" ? commands[0].options.stdout : undefined,
        "inherit"
      )
    }))

  it.effect("still reports a non-zero exit when the output is routed to stderr", () =>
    Effect.gen(function*() {
      const commands: Array<ChildProcess.Command> = []
      const layer = PackageManager.PackageManager.layer.pipe(
        Layer.provide(Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.sync(() => {
              commands.push(command)
              return ChildProcessSpawner.makeHandle({
                ...handleEmitting([]),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(7))
              })
            })
          )
        )),
        Layer.provide(Stdio.layerTest({}))
      )
      const error = yield* Effect.flip(
        Effect.flatMap(
          PackageManager.PackageManager,
          (pm) => pm.install("/out/my-api", "npm", { stdout: "stderr" })
        ).pipe(Effect.provide(layer))
      )
      assert.strictEqual(error._tag, "InstallFailed")
    }))

  it.effect("reports a failure to spawn as PackageManagerMissing, not as exit -1", () =>
    Effect.gen(function*() {
      const enoent = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "ENOENT"
      })
      const error = yield* Effect.flip(
        run(() => Effect.fail(enoent), (pm) => pm.install("/out/my-api", "bun"))
      )
      assert.strictEqual(error._tag, "PackageManagerMissing")
      assert.include(error.message, "bun")
      assert.include(error.message, "does not appear to be installed")
    }))
})
