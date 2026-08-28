import { expect, test } from "bun:test"
import { Effect, References } from "effect"
import { UserId } from "./domain/User.ts"
import { Users } from "./Users.ts"

// Tests run against the real layer, not a mock: `layerMemory` IS the seam.
const run = <A, E>(effect: Effect.Effect<A, E, Users>) =>
  effect.pipe(
    Effect.provide(Users.layerMemory),
    // Keep the output to the assertions; raise this to see app logs.
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.runPromise
  )

test("creates then lists a user", () =>
  run(Effect.gen(function*() {
    const users = yield* Users
    const created = yield* users.create({ name: "Ada", email: "ada@example.com" })
    expect(created.name).toBe("Ada")

    const listed = yield* users.list
    expect(listed.length).toBe(1)
    expect(listed[0]?.id).toBe(created.id)
  })))

test("fails with UserNotFound for an unknown id", () =>
  run(Effect.gen(function*() {
    const users = yield* Users
    const error = yield* Effect.flip(users.getById(UserId.make("nope")))
    expect(error._tag).toBe("UserNotFound")
  })))
