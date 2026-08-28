import { Context, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class Git extends Context.Service<Git, {
  init(cwd: string): Effect.Effect<void>
}>()("create-effect-project/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      return Git.of({
        init: (cwd) =>
          spawner.exitCode(ChildProcess.make("git", ["init", "--quiet"], { cwd })).pipe(
            Effect.flatMap((exitCode) =>
              exitCode === ChildProcessSpawner.ExitCode(0)
                ? Effect.void
                : Effect.logWarning(`git init exited with ${exitCode}; skipping repository setup`)
            ),
            Effect.catchCause(() =>
              Effect.logWarning("git is unavailable; skipping repository setup")
            )
          )
      })
    })
  )
}
