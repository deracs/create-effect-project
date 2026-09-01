import { Config, Context, Effect, Layer, Stdio, Stream } from "effect"
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

export interface InstallOptions {
  /**
   * Where the package manager's own output goes.
   *
   * `"inherit"` hands the child the real file descriptors, which is what makes
   * npm and friends print their progress bars.
   *
   * `"stderr"` is for when stdout is reserved — under `--print-dir` the shell is
   * capturing it to get the project path, and a progress bar landing in there
   * would end up inside the `cd` argument. The output is still shown, just on
   * the other stream: a silent minute during a large install is what the
   * progress is there to prevent.
   */
  readonly stdout?: "inherit" | "stderr" | undefined
}

export class PackageManager extends Context.Service<PackageManager, {
  install(
    cwd: string,
    manager: Name,
    options?: InstallOptions
  ): Effect.Effect<void, InstallFailed | PackageManagerMissing>
}>()("yieldit/PackageManager") {
  static readonly layer = Layer.effect(
    PackageManager,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const stdio = yield* Stdio.Stdio

      const command = (cwd: string, manager: Name, stdout: "inherit" | "pipe") =>
        ChildProcess.make(manager, ["install"], {
          cwd,
          extendEnv: true,
          stdout,
          // stderr is never the reserved stream, so it is always the terminal's.
          stderr: "inherit"
        })

      /**
       * Pumps the child's stdout to our stderr, then reads the exit code.
       * Sequential rather than concurrent because the stream ends when the child
       * closes stdout, which it does as it exits — so there is nothing to
       * interleave, and no fiber left running past the return.
       */
      const throughStderr = (cwd: string, manager: Name) =>
        Effect.scoped(Effect.gen(function*() {
          const handle = yield* spawner.spawn(command(cwd, manager, "pipe"))
          // `endOnDone: false` — the process's stderr ending is not our stderr
          // ending; the CLI still has next steps to print.
          yield* Stream.run(handle.stdout, stdio.stderr({ endOnDone: false }))
          return yield* handle.exitCode
        }))

      return PackageManager.of({
        install: (cwd, manager, options) =>
          Effect.gen(function*() {
            yield* Effect.log(`Installing dependencies with ${manager}...`)
            const exitCode = yield* (
              options?.stdout === "stderr"
                ? throughStderr(cwd, manager)
                : spawner.exitCode(command(cwd, manager, "inherit"))
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
