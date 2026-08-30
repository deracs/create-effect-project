import { Config, Context, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { InstallFailed, PackageManagerMissing } from "./Errors.ts"

export const names = ["npm", "pnpm", "yarn", "bun"] as const

export type Name = typeof names[number]

const isName = (value: string): value is Name => (names as ReadonlyArray<string>).includes(value)

/**
 * npm-family managers set `npm_config_user_agent` to a string beginning
 * `<manager>/<version>`. Anything unrecognised falls back to npm, which is
 * always present alongside Node.
 */
export const parseUserAgent = (userAgent: string | undefined): Name => {
  if (userAgent === undefined) return "npm"
  const candidate = userAgent.trim().split(/[/\s]/, 1)[0]
  return candidate !== undefined && isName(candidate) ? candidate : "npm"
}

/** Reads the ambient package manager at the boundary. Never fails. */
export const detect: Effect.Effect<Name> = Config.string("npm_config_user_agent").pipe(
  Config.option,
  Effect.map((option) => parseUserAgent(option._tag === "Some" ? option.value : undefined)),
  Effect.orElseSucceed(() => "npm" as Name)
)

/**
 * A bun project is installed with bun regardless of what launched the CLI —
 * its lockfile and `@types/bun` belong to bun. Node projects have no such
 * constraint, so `undefined` means "use whatever `detect` finds".
 */
export const forRuntime = (runtime: "node" | "bun"): Name | undefined =>
  runtime === "bun" ? "bun" : undefined

export class PackageManager extends Context.Service<PackageManager, {
  install(cwd: string, manager: Name): Effect.Effect<void, InstallFailed | PackageManagerMissing>
}>()("create-effect-project/PackageManager") {
  static readonly layer = Layer.effect(
    PackageManager,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      return PackageManager.of({
        install: (cwd, manager) =>
          Effect.gen(function*() {
            yield* Effect.log(`Installing dependencies with ${manager}...`)
            const exitCode = yield* spawner.exitCode(
              // The manager's own output goes straight to the terminal. A large
              // template takes the better part of a minute to install, and
              // silence for that long is indistinguishable from a hang. Real
              // progress beats a spinner, and every manager already degrades to
              // plain lines when stdout is not a TTY, so CI stays readable.
              ChildProcess.make(manager, ["install"], {
                cwd,
                extendEnv: true,
                stdout: "inherit",
                stderr: "inherit"
              })
            ).pipe(
              // A spawn failure is not an exit code — reporting it as one would
              // make "not installed" indistinguishable from "exited -1".
              Effect.mapError((cause) => new PackageManagerMissing({ packageManager: manager, cause }))
            )
            if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
              return yield* new InstallFailed({ packageManager: manager, exitCode })
            }
          })
      })
    })
  )
}
