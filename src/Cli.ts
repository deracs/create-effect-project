import { Console, Effect, Logger, Option, Path, Schema } from "effect"
import { CliError, Command, Flag, Prompt } from "effect/unstable/cli"
import * as PackageManager from "./PackageManager.ts"
import * as Project from "./Project.ts"
import * as Template from "./Template.ts"

/**
 * The name is used unchanged as both the target directory and the `name` in
 * `package.json`, so it must be a valid unscoped npm package name AND a single
 * path segment. The leading alphanumeric rules out `.`, `..` and dotfiles; the
 * character class rules out separators, quotes and control characters, any of
 * which would otherwise escape the working directory or corrupt the manifest.
 */
const ProjectName = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/, {
      message: "must be a valid npm package name: lowercase letters, digits, '.', '-' and '_', " +
        "beginning with a letter or digit, and a single path segment"
    }),
    Schema.isMaxLength(214)
  )
)

// `withSchema` is applied outside `withFallbackPrompt` so a prompted name is
// validated on the same terms as a flag.
const name = Flag.string("name").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Directory and package name for the new project"),
  Flag.withFallbackPrompt(Prompt.text({
    message: "Project name",
    default: "my-effect-app"
  })),
  Flag.withSchema(ProjectName)
)

// Choices are derived from the registry, so a new template is offered here the
// moment it is added to `Template.ids` — there is no second list to update.
const template = Flag.choice("template", Template.ids).pipe(
  Flag.withAlias("t"),
  Flag.withDescription("Kind of project to scaffold"),
  Flag.withFallbackPrompt(Prompt.select({
    message: "Template",
    choices: Template.ids.map((id, index) => ({
      title: Template.byId(id).title,
      value: id,
      selected: index === 0
    }))
  }))
)

const runtime = Flag.choice("runtime", Template.runtimes).pipe(
  Flag.withDescription("Runtime to target"),
  Flag.withFallbackPrompt(Prompt.select({
    message: "Runtime",
    choices: [
      { title: "Node.js", value: "node" as const },
      { title: "Bun", value: "bun" as const }
    ]
  }))
)

const packageManager = Flag.choice("pm", PackageManager.names).pipe(
  Flag.withDescription("Package manager to install with (prompted for node, bun for bun)"),
  Flag.optional
)

/**
 * Resolves the package manager when `--pm` was not supplied.
 *
 * A bun project's lockfile and `@types/bun` belong to bun, so there is nothing
 * worth asking. A node project genuinely has a choice, so offer it — with
 * whatever launched the CLI pre-selected, so pressing Enter does the expected
 * thing.
 */
const resolvePackageManager = Effect.fn("Cli.resolvePackageManager")(
  function*(runtime: Template.Runtime) {
    const forced = PackageManager.forRuntime(runtime)
    if (forced !== undefined) return forced

    const detected = yield* PackageManager.detect
    return yield* Prompt.select({
      message: "Package manager",
      choices: PackageManager.names.map((manager) => ({
        title: manager === detected ? `${manager} (detected)` : manager,
        value: manager,
        selected: manager === detected
      }))
    })
  }
)

const otel = Flag.boolean("otel").pipe(
  Flag.withDescription("Wire up OTLP logs, metrics and traces"),
  Flag.withDefault(true)
)

const lint = Flag.boolean("lint").pipe(
  Flag.withDescription("Add oxlint and the Effect language service via @effect/tsgo"),
  Flag.withDefault(true)
)

const slop = Flag.boolean("slop").pipe(
  Flag.withDescription(
    "Add stricter oxlint rules that catch sloppy code — `any`, `@ts-ignore`, " +
    "non-null assertions, empty blocks, dead branches (requires --lint)"
  ),
  Flag.withDefault(false)
)

const install = Flag.boolean("install").pipe(
  Flag.withDescription("Install dependencies after scaffolding"),
  Flag.withDefault(true)
)

const git = Flag.boolean("git").pipe(
  Flag.withDescription("Initialise a git repository"),
  Flag.withDefault(true)
)

/**
 * A child process cannot change its parent shell's working directory, so the
 * CLI cannot cd anywhere for you. What it can do is name the directory on
 * stdout and let the shell do it:
 *
 *     cd "$(npx create-effect-project --name my-app --template cli --print-dir)"
 *
 * Effect's default logger writes to stdout, so the flag also moves every log
 * line to stderr, and tells the package manager to send its own output there
 * too. Stdout then carries the path and nothing else. That is what makes the
 * CLI scriptable as well: a caller gets a machine-readable path instead of
 * scraping log lines for it.
 */
const printDir = Flag.boolean("print-dir").pipe(
  Flag.withDescription("Print the new project's absolute path to stdout, for `cd \"$(...)\"`"),
  Flag.withDefault(false)
)

export const root = Command.make(
  "create-effect-project",
  { name, template, runtime, packageManager, otel, lint, slop, install, git, printDir },
  Effect.fn(function*(input) {
    yield* Effect.gen(function*() {
      // Explicit --pm wins; otherwise bun projects use bun and node projects ask.
      const manager = Option.isSome(input.packageManager)
        ? input.packageManager.value
        : yield* resolvePackageManager(input.runtime)

      const chosen = Template.byId(input.template)

      // Same principle as --slop below: never accept a flag we would ignore.
      if (input.otel && !chosen.supportsOtel) {
        yield* Effect.logWarning(
          `--otel does not apply to the ${chosen.id} template, so no telemetry was wired up. ` +
          "See the generated README for the approach that fits this target."
        )
      }

      // `--slop` patches the oxlint config that `--lint` writes, so on its own it
      // would silently do nothing. Say so rather than ignoring a flag they typed.
      if (input.slop && !input.lint) {
        yield* Effect.logWarning(
          "--slop needs --lint: the stricter rules are added to the oxlint config " +
          "that --lint writes, so nothing was added."
        )
      }

      const selection: Template.Selection = {
        runtime: input.runtime,
        otel: input.otel,
        lint: input.lint,
        slop: input.slop,
        packageManager: manager
      }

      const result = yield* Project.scaffold({
        name: input.name,
        directory: input.name,
        templateRoot: Template.templateRoot(import.meta.url),
        template: chosen,
        selection,
        packageManager: manager,
        install: input.install,
        git: input.git,
        // stdout belongs to the path under --print-dir, so the manager's progress
        // has to go somewhere else.
        installOutput: input.printDir ? "stderr" : undefined
      }).pipe(
        // The one expected user error: report it as a sentence and exit non-zero,
        // rather than letting the runtime print a tag and a stack trace.
        Effect.catchTag("TargetNotEmpty", (error) =>
          new CliError.UserError({ cause: error, userMessage: error.message })
        )
      )

      yield* Effect.log(
        `Created ${input.name} (${chosen.id}, ${input.runtime}) with ${result.files.length} files`
      )
      // Appended whenever dependencies are missing — declined OR failed.
      yield* Effect.log(
        `  cd ${input.name}${result.dependenciesInstalled ? "" : ` && ${manager} install`}`
      )
      // The template owns its own next steps: a non-server project has no
      // `client` script and nothing to open in a browser.
      for (const step of chosen.nextSteps(selection)) {
        yield* Effect.log(`  ${step}`)
      }

      // Last, and only on success: a path on stdout means the directory is there
      // and ready. `Console.log` writes to stdout; every `Effect.log` above has
      // just been routed away from it.
      if (input.printDir) {
        const path = yield* Path.Path
        yield* Console.log(path.resolve(input.name))
      }
    }).pipe(
      // Effect's default logger writes to stdout. Under --print-dir the path is
      // the only thing allowed there, so move the whole run's logging rather
      // than auditing which lines matter — including the package manager's,
      // which logs from inside `Project.scaffold`.
      Effect.provideService(Logger.LogToStderr, input.printDir)
    )
  })
).pipe(
  Command.withDescription(
    "Scaffold an Effect v4 project — an HttpApi server, a full-stack app, a plain program, " +
    "a CLI, an AI agent with typed tools, or a Cloudflare Worker"
  ),
  Command.withExamples([
    { command: "create-effect-project", description: "Prompt for a name, template, runtime and package manager" },
    {
      command: "create-effect-project --name my-api --template http-server --runtime bun",
      description: "Scaffold an HttpApi server and client on bun"
    },
    {
      command: "create-effect-project --name my-app --template fullstack --runtime bun",
      description: "Scaffold an HttpApi server and a server-rendered React UI that shares its types"
    },
    {
      command: "create-effect-project --name my-app --template basic --runtime node --pm pnpm",
      description: "Scaffold a plain program and install with pnpm, without prompting"
    },
    {
      command: "create-effect-project --name my-app --template basic --no-otel --no-lint",
      description: "Scaffold without telemetry or linting"
    },
    {
      command: "create-effect-project --name my-api --template http-server --slop",
      description: "Scaffold with the stricter anti-slop oxlint rules"
    },
    {
      command: "create-effect-project --name my-notes --template cli --runtime node",
      description: "Scaffold a command-line app with subcommands, prompts and typed exit codes"
    },
    {
      command: "create-effect-project --name my-agent --template ai",
      description: "Scaffold a language model with the Notes service exposed to it as typed tools"
    },
    {
      command: "create-effect-project --name my-api --template alchemy-http",
      description: "Scaffold the same HttpApi as a Cloudflare Worker deployed with Alchemy"
    },
    {
      command: "create-effect-project --name my-api --template alchemy-rpc",
      description: "Scaffold a typed RPC service on a Cloudflare Worker"
    },
    {
      command: 'cd "$(create-effect-project --name my-app --template cli --print-dir)"',
      description: "Scaffold, then land in the new project — stdout carries the path and nothing else"
    }
  ])
)
