import { Schema } from "effect"

/** The target directory already exists and is not empty. The only user error. */
export class TargetNotEmpty extends Schema.TaggedError<TargetNotEmpty>()("TargetNotEmpty", {
  path: Schema.String
}) {
  override get message(): string {
    return `${this.path} already exists and is not empty. ` +
      `Choose another name, or remove the directory and try again.`
  }
}

/** A template file could not be read or written. */
export class TemplateWriteFailed extends Schema.TaggedError<TemplateWriteFailed>()("TemplateWriteFailed", {
  path: Schema.String,
  cause: Schema.Defect()
}) {}

/** Dependency installation exited non-zero. Never fatal — the project is already on disk. */
export class InstallFailed extends Schema.TaggedError<InstallFailed>()("InstallFailed", {
  packageManager: Schema.String,
  exitCode: Schema.Number
}) {
  override get message(): string {
    return `\`${this.packageManager} install\` exited with ${this.exitCode}`
  }
}

/**
 * The package manager could not be started at all — almost always because it is
 * not on `PATH`. Distinct from `InstallFailed` because the advice differs: no
 * amount of re-running `<pm> install` helps until the tool is installed.
 */
export class PackageManagerMissing extends Schema.TaggedError<PackageManagerMissing>()(
  "PackageManagerMissing",
  {
    packageManager: Schema.String,
    cause: Schema.Defect()
  }
) {
  override get message(): string {
    return `\`${this.packageManager}\` could not be started — it does not appear to be installed`
  }
}
