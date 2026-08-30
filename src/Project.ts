import { Effect, FileSystem, Path } from "effect"
import { TargetNotEmpty, type TemplateWriteFailed } from "./Errors.ts"
import { Git } from "./Git.ts"
// `PackageManager` is a service class, not a namespace — the `Name` type must be
// imported separately rather than reached through it.
import { type InstallOptions, type Name, PackageManager } from "./PackageManager.ts"
import * as Template from "./Template.ts"

export interface ScaffoldResult {
  /** Project-relative paths of the files written, in the order they were written. */
  readonly files: ReadonlyArray<string>
  /**
   * Whether dependencies are on disk. False when `install` was declined and
   * false when the install was attempted and failed, so the caller can tell the
   * user to run it themselves in both cases.
   */
  readonly dependenciesInstalled: boolean
}

export interface ScaffoldOptions {
  readonly name: string
  readonly directory: string
  readonly templateRoot: string
  readonly template: Template.Template
  readonly selection: Template.Selection
  readonly packageManager: Name
  readonly install: boolean
  readonly git: boolean
  /**
   * Where the package manager's own output goes. Passed straight through: the
   * caller is the one that knows whether stdout is reserved, which under
   * `--print-dir` it is.
   */
  readonly installOutput?: InstallOptions["stdout"] | undefined
}

export const scaffold = (
  options: ScaffoldOptions
): Effect.Effect<
  ScaffoldResult,
  TargetNotEmpty | TemplateWriteFailed,
  FileSystem.FileSystem | Path.Path | PackageManager | Git
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const packageManager = yield* PackageManager
    const git = yield* Git

    // Refuse before writing anything. An existing but empty directory is fine.
    const existed = yield* fs.exists(options.directory).pipe(Effect.orElseSucceed(() => false))
    if (existed) {
      const entries = yield* fs.readDirectory(options.directory).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>)
      )
      if (entries.length > 0) {
        return yield* new TargetNotEmpty({ path: options.directory })
      }
    }

    const written = yield* Template.render({
      template: options.template,
      sourceRoot: options.templateRoot,
      targetDir: options.directory,
      projectName: options.name,
      selection: options.selection
    }).pipe(
      // Clean up only what we created. A directory the user already had stays.
      Effect.onError(() =>
        existed
          ? Effect.void
          : fs.remove(options.directory, { recursive: true }).pipe(Effect.ignore)
      )
    )

    // Not fatal: the project is on disk and valid. Deleting it because a
    // registry hiccuped, or because the manager is missing, would be the wrong
    // trade — so both failures are reported and reduced to "not installed".
    const dependenciesInstalled = options.install
      ? yield* packageManager.install(options.directory, options.packageManager, {
        stdout: options.installOutput
      }).pipe(
        Effect.as(true),
        Effect.catchTag(["InstallFailed", "PackageManagerMissing"], (error) =>
          Effect.logWarning(
            `${error.message}. Dependencies are not installed — ` +
            `run \`${error.packageManager} install\` in ${options.directory} to finish setup.`
          ).pipe(Effect.as(false))
        )
      )
      : false

    if (options.git) {
      yield* git.init(options.directory)
    }

    return { files: written, dependenciesInstalled }
  })
