import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { InstallFailed, PackageManagerMissing, TargetNotEmpty, TemplateWriteFailed } from "../src/Errors.ts"

describe("Errors", () => {
  it.effect("TargetNotEmpty is yieldable and carries its path", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Effect.gen(function*() {
        return yield* new TargetNotEmpty({ path: "/tmp/taken" })
      }))
      assert.strictEqual(error._tag, "TargetNotEmpty")
      assert.strictEqual(error.path, "/tmp/taken")
    }))

  it("TargetNotEmpty reads as a sentence naming the path", () => {
    const error = new TargetNotEmpty({ path: "/tmp/taken" })
    assert.include(error.message, "/tmp/taken")
    assert.include(error.message, "already exists and is not empty")
    assert.notInclude(error.message, "TargetNotEmpty")
  })

  it("InstallFailed and PackageManagerMissing say different things", () => {
    const failed = new InstallFailed({ packageManager: "bun", exitCode: 1 })
    const missing = new PackageManagerMissing({ packageManager: "bun", cause: new Error("ENOENT") })
    assert.include(failed.message, "exited with 1")
    assert.include(missing.message, "does not appear to be installed")
    assert.notStrictEqual(failed.message, missing.message)
  })

  it.effect("TemplateWriteFailed retains an arbitrary cause", () =>
    Effect.gen(function*() {
      const cause = new Error("EACCES")
      const error = yield* Effect.flip(Effect.gen(function*() {
        return yield* new TemplateWriteFailed({ path: "src/server.ts", cause })
      }))
      assert.strictEqual(error._tag, "TemplateWriteFailed")
      assert.strictEqual(error.path, "src/server.ts")
      assert.strictEqual(error.cause, cause)
    }))

  it.effect("InstallFailed carries the manager and exit code", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Effect.gen(function*() {
        return yield* new InstallFailed({ packageManager: "pnpm", exitCode: 1 })
      }))
      assert.strictEqual(error._tag, "InstallFailed")
      assert.strictEqual(error.packageManager, "pnpm")
      assert.strictEqual(error.exitCode, 1)
    }))
})
