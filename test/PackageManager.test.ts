import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
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
      Effect.provide(PackageManager.PackageManager.layer.pipe(Layer.provide(spawnerWith(exitCode))))
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
