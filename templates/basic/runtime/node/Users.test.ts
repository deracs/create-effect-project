import { assert, describe, it } from "@effect/vitest"
import { Effect, References } from "effect"
import { UserId } from "./domain/User.ts"
import { Users } from "./Users.ts"

// Tests run against the real layer, not a mock: `layerMemory` IS the seam.
const run = <A, E>(effect: Effect.Effect<A, E, Users>) =>
  effect.pipe(
    Effect.provide(Users.layerMemory),
    // Keep the output to the assertions; raise this to see app logs.
    Effect.provideService(References.MinimumLogLevel, "None")
  )

describe("users", () => {
  it.effect("creates then lists a user", () =>
    run(Effect.gen(function*() {
      const users = yield* Users
      const created = yield* users.create({ name: "Ada", email: "ada@example.com" })
      assert.strictEqual(created.name, "Ada")

      const listed = yield* users.list
      assert.strictEqual(listed.length, 1)
      assert.strictEqual(listed[0]?.id, created.id)
    })))

  it.effect("fails with UserNotFound for an unknown id", () =>
    run(Effect.gen(function*() {
      const users = yield* Users
      const error = yield* Effect.flip(users.getById(UserId.make("nope")))
      assert.strictEqual(error._tag, "UserNotFound")
    })))
})
