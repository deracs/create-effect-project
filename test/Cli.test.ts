import { assert, describe, it } from "@effect/vitest"
import type { Cause } from "effect"
import { Console, Effect, FileSystem, Layer, Logger, Option, Path, Queue, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process"
import { root } from "../src/Cli.ts"
import { InstallFailed, PackageManagerMissing } from "../src/Errors.ts"
import { Git } from "../src/Git.ts"
import { PackageManager } from "../src/PackageManager.ts"
import { isAbsolute, resolve } from "node:path"
import * as PackageManagerModule from "../src/PackageManager.ts"

interface Journal {
  /** cwd, manager, and where the manager was told to send its own output. */
  readonly installs: Array<readonly [string, string, string | undefined]>
  readonly gitInits: Array<string>
  readonly writes: Array<string>
  /** Rendered log messages, so the printed next steps can be asserted on. */
  readonly logs: Array<string>
  /** What `Console.error` was called with, i.e. what the user actually sees on a UserError. */
  readonly errors: Array<string>
  /**
   * What reached real stdout. Separate from `logs` because the two streams are
   * the whole point of `--print-dir`: everything human goes to stderr, so a
   * caller can substitute the command and get a path and nothing else.
   */
  readonly stdout: Array<string>
}

/** A terminal that replays `keys` as if typed, for the fallback prompts. */
const replaying = (keys: ReadonlyArray<Terminal.UserInput>) =>
  Layer.succeed(Terminal.Terminal, Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.gen(function*() {
      const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>()
      yield* Queue.offerAll(queue, keys)
      yield* Queue.end(queue)
      return queue
    }),
    readLine: Effect.die("unused"),
    display: () => Effect.void
  }))

const enter: Terminal.UserInput = {
  input: Option.none(),
  key: { name: "return", ctrl: false, meta: false, shift: false }
}

/** One special key press by name, e.g. "down", for the select prompts. */
const press = (name: string): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl: false, meta: false, shift: false }
})

/** One keystroke typing `char`, as the text prompt's default (non-special-key) case expects. */
const type = (char: string): Terminal.UserInput => ({
  input: Option.some(char),
  key: { name: char, ctrl: false, meta: false, shift: false }
})

const harness = (overrides: {
  readonly failInstall?: boolean
  readonly missingManager?: boolean
  readonly nonEmptyTarget?: boolean
  readonly terminal?: Layer.Layer<Terminal.Terminal>
} = {}) => {
  const journal: Journal = { installs: [], gitInits: [], writes: [], logs: [], errors: [], stdout: [] }
  const written = new Map<string, string>()
  // The CLI runner renders `CliError.UserError` via `Console.error`, not `Stdio`,
  // so capturing what the user sees means swapping the `Console` service.
  const testConsole: Console.Console = Object.assign(Object.create(console), {
    error: (...args: ReadonlyArray<unknown>) => journal.errors.push(args.map(String).join(" ")),
    log: (...args: ReadonlyArray<unknown>) => journal.stdout.push(args.map(String).join(" "))
  })
  const layer = Layer.mergeAll(
    Layer.succeed(Console.Console, testConsole),
    FileSystem.layerNoop({
      exists: () => Effect.succeed(overrides.nonEmptyTarget === true),
      readDirectory: () => Effect.succeed(["already-here"]),
      makeDirectory: () => Effect.void,
      readFileString: (path) =>
        Effect.succeed(written.get(path as string) ?? `{"scripts":{},"devDependencies":{}}`),
      writeFileString: (path, data) =>
        Effect.sync(() => {
          written.set(path as string, data)
          journal.writes.push(path as string)
        })
    }),
    Path.layer,
    Stdio.layerTest({}),
    Logger.layer([Logger.make(({ message }) => {
      journal.logs.push(Array.isArray(message) ? message.map(String).join(" ") : String(message))
    })]),
    overrides.terminal ?? replaying([]),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("unused"))
    ),
    Layer.succeed(PackageManager, PackageManager.of({
      install: (cwd, manager, options) => {
        journal.installs.push([cwd, manager, options?.stdout] as const)
        if (overrides.missingManager === true) {
          return Effect.fail(new PackageManagerMissing({ packageManager: manager, cause: new Error("ENOENT") }))
        }
        return overrides.failInstall === true
          ? Effect.fail(new InstallFailed({ packageManager: manager, exitCode: 1 }))
          : Effect.void
      }
    })),
    Layer.succeed(Git, Git.of({
      init: (cwd) => Effect.sync(() => { journal.gitInits.push(cwd) })
    }))
  )
  return { journal, layer, written }
}

const runWith = (argv: ReadonlyArray<string>) => Command.runWith(root, { version: "0.1.0" })(argv)

/**
 * Most tests are not about template selection, and `--template` prompts when
 * omitted — an unanswered prompt would hang them. Default it here; `runWith` is
 * the raw runner used by the template tests themselves.
 */
const run = (argv: ReadonlyArray<string>) =>
  runWith(argv.includes("--template") ? argv : [...argv, "--template", "http-server"])

describe("Cli", () => {
  it.effect("scaffolds a node project from flags with no prompting", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "pnpm"])
      assert.isNotEmpty(journal.writes)
      assert.deepStrictEqual(journal.installs.map(([, m]) => m), ["pnpm"])
      assert.strictEqual(journal.gitInits.length, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("installs a bun project with bun when --pm is not given", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "bun"])
      assert.deepStrictEqual(journal.installs.map(([, m]) => m), ["bun"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("asks a node project which package manager to use, and installs with the answer", () => {
    // Enter accepts the pre-selected (detected) entry. Without a --pm flag a
    // node project must ask rather than silently pick.
    const { journal, layer } = harness({ terminal: replaying([enter]) })
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node"])
      assert.strictEqual(journal.installs.length, 1)
      assert.include(PackageManagerModule.names, journal.installs[0]?.[1])
    }).pipe(Effect.provide(layer))
  })

  it.effect("installs with a package manager chosen further down the prompt list", () => {
    // One "down" moves off the pre-selected entry, so the value used must differ
    // from the default — proving the answer is read, not assumed.
    const first = harness({ terminal: replaying([enter]) })
    const second = harness({ terminal: replaying([press("down"), enter]) })
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node"]).pipe(Effect.provide(first.layer))
      yield* run(["--name", "my-api", "--runtime", "node"]).pipe(Effect.provide(second.layer))
      assert.notStrictEqual(second.journal.installs[0]?.[1], first.journal.installs[0]?.[1])
    })
  })

  it.effect("does not ask a bun project — its lockfile belongs to bun", () => {
    // No terminal input queued: if this prompted, it would fail rather than pass.
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "bun"])
      assert.deepStrictEqual(journal.installs.map(([, m]) => m), ["bun"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("lets an explicit --pm override the runtime default", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "bun", "--pm", "npm"])
      assert.deepStrictEqual(journal.installs.map(([, m]) => m), ["npm"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("honours --no-install and --no-git", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--no-install", "--no-git"])
      assert.isNotEmpty(journal.writes)
      assert.deepStrictEqual(journal.installs, [])
      assert.deepStrictEqual(journal.gitInits, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("omits lint config with --no-lint", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--no-lint"])
      assert.isTrue(journal.writes.every((p) => !p.endsWith(".oxlintrc.json")))
    }).pipe(Effect.provide(layer))
  })

  it.effect("includes lint config by default", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm"])
      assert.isTrue(journal.writes.some((p) => p.endsWith(".oxlintrc.json")))
    }).pipe(Effect.provide(layer))
  })

  it.effect("scaffolds the basic template as a program, not a server", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-app", "--runtime", "node", "--pm", "npm", "--template", "basic"])
      const written = journal.writes.map((path) => path.replace("my-app/", ""))
      assert.include(written, "src/main.ts")
      assert.include(written, "src/Users.ts")
      assert.notInclude(written, "src/index.ts")
      assert.notInclude(written, "src/client.ts")
    }).pipe(Effect.provide(layer))
  })

  it.effect("prints next steps belonging to the chosen template", () => {
    // The server template's hint used to be hardcoded in the CLI, so a basic
    // project would have been told to open /docs and run a `client` script it
    // does not have.
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-app", "--runtime", "node", "--pm", "npm", "--template", "basic"])
      const output = journal.logs.join("\n")
      assert.include(output, "npm run dev")
      assert.include(output, "src/main.ts")
      assert.notInclude(output, "client")
      assert.notInclude(output, "/docs")
    }).pipe(Effect.provide(layer))
  })

  it.effect("names the chosen template in the summary line", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-app", "--runtime", "bun", "--template", "basic"])
      assert.isTrue(
        journal.logs.some((line) => line.includes("my-app") && line.includes("basic")),
        `summary line named no template: ${journal.logs.join(" | ")}`
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("prompts for the template when it is omitted, defaulting to the first", () => {
    // Bare Enter takes the pre-selected entry, which is `Template.ids[0]`.
    const { journal, layer } = harness({ terminal: replaying([enter]) })
    return Effect.gen(function*() {
      yield* runWith(["--name", "my-api", "--runtime", "node", "--pm", "npm"])
      const written = journal.writes.map((path) => path.replace("my-api/", ""))
      assert.include(written, "src/index.ts")
      assert.notInclude(written, "src/main.ts")
    }).pipe(Effect.provide(layer))
  })

  it.effect("scaffolds the template selected further down the prompt list", () => {
    // One "down" then Enter — proves the prompt's answer is actually used,
    // which a bare-Enter replay (always the default) cannot show.
    const { journal, layer } = harness({ terminal: replaying([press("down"), enter]) })
    return Effect.gen(function*() {
      yield* runWith(["--name", "my-app", "--runtime", "node", "--pm", "npm"])
      const written = journal.writes.map((path) => path.replace("my-app/", ""))
      assert.include(written, "apps/web/src/router.tsx")
      assert.notInclude(written, "src/index.ts")
    }).pipe(Effect.provide(layer))
  })

  // This harness fakes the template sources, so the merged RULE CONTENT is
  // asserted in Template.test.ts against the real files on disk. What belongs
  // here is that the CLI threads --slop through at all: the config is written
  // once as a file, then a second time by the patch, so two writes means the
  // patch fired and one means it did not.
  const oxlintWrites = (writes: ReadonlyArray<string>) =>
    writes.filter((path) => path.endsWith(".oxlintrc.json")).length

  it.effect("applies the slop patch to the oxlint config with --slop", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--slop"])
      assert.strictEqual(oxlintWrites(journal.writes), 2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("leaves the oxlint config unpatched by default", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm"])
      assert.strictEqual(oxlintWrites(journal.writes), 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("warns rather than silently ignoring --slop --no-lint", () => {
    // The rules are a patch onto the config --lint writes, so without --lint
    // there is nothing to patch. Ignoring a flag the user typed is worse than
    // saying so.
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--slop", "--no-lint"])
      assert.isTrue(
        journal.logs.some((line) => line.includes("--slop needs --lint")),
        `no warning was logged: ${journal.logs.join(" | ")}`
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects an unknown template", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(
        runWith(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--template", "graphql"])
      )
      assert.strictEqual(exit._tag, "Failure")
      assert.deepStrictEqual(journal.writes, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects an unknown runtime", () => {
    const { layer } = harness()
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(run(["--name", "my-api", "--runtime", "deno"]))
      assert.strictEqual(exit._tag, "Failure")
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects an unknown package manager", () => {
    const { layer } = harness()
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(run(["--name", "my-api", "--runtime", "node", "--pm", "cargo"]))
      assert.strictEqual(exit._tag, "Failure")
    }).pipe(Effect.provide(layer))
  })

  // The name becomes both a directory and the `name` in package.json, so an
  // unvalidated one either escapes the working directory or corrupts JSON.
  for (const rejected of ['my "api"', "a/b", "a\\b", "..", ".", ".hidden", "My-API", "my api", ""]) {
    it.effect(`rejects the name ${JSON.stringify(rejected)} before writing anything`, () => {
      const { journal, layer } = harness()
      return Effect.gen(function*() {
        const exit = yield* Effect.exit(run(["--name", rejected, "--runtime", "node"]))
        assert.strictEqual(exit._tag, "Failure")
        assert.deepStrictEqual(journal.writes, [])
        assert.deepStrictEqual(journal.installs, [])
      }).pipe(Effect.provide(layer))
    })
  }

  for (const accepted of ["my-api", "my_api", "api.v2", "a", "notes3"]) {
    it.effect(`accepts the name ${JSON.stringify(accepted)}`, () => {
      const { journal, layer } = harness()
      return Effect.gen(function*() {
        yield* run(["--name", accepted, "--runtime", "node", "--pm", "npm"])
        assert.isNotEmpty(journal.writes)
      }).pipe(Effect.provide(layer))
    })
  }

  it.effect("rejects a name longer than npm allows", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(run(["--name", "a".repeat(215), "--runtime", "node"]))
      assert.strictEqual(exit._tag, "Failure")
      assert.deepStrictEqual(journal.writes, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("prompts when --name is omitted", () => {
    // A bare Enter accepts the prompt's default, which must survive validation:
    // `withSchema` is applied outside `withFallbackPrompt`, so it sees this value.
    const { journal, layer } = harness({ terminal: replaying([enter]) })
    return Effect.gen(function*() {
      yield* run(["--runtime", "node"])
      assert.isNotEmpty(journal.writes)
      assert.isTrue(journal.logs.some((line) => line.includes("Created my-effect-app")))
    }).pipe(Effect.provide(layer))
  })

  it.effect("validates a name typed at the prompt, not just the default it offers", () => {
    // Types an extra uppercase character onto the prompt's default, producing
    // "my-effect-appX" — rejected by the same pattern a bad --name would hit.
    // `withSchema` sits outside `withFallbackPrompt`, so a typed value must be
    // checked on the same terms as a flag; a bare-Enter replay (which only ever
    // submits the already-valid default) can't tell the two apart.
    const { journal, layer } = harness({ terminal: replaying([type("X"), enter]) })
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(run(["--runtime", "node"]))
      assert.strictEqual(exit._tag, "Failure")
      assert.deepStrictEqual(journal.writes, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("tells the user to install when the install failed, not just when it was declined", () => {
    const { journal, layer } = harness({ failInstall: true })
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "pnpm"])
      assert.deepStrictEqual(journal.installs.map(([, m]) => m), ["pnpm"])
      assert.isTrue(
        journal.logs.some((line) => line.includes("cd my-api && pnpm install")),
        `next steps omitted the install command: ${JSON.stringify(journal.logs)}`
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("names a missing package manager as the cause", () => {
    const { journal, layer } = harness({ missingManager: true })
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "bun"])
      assert.isTrue(
        journal.logs.some((line) => line.includes("`bun` could not be started")),
        `no missing-manager warning: ${JSON.stringify(journal.logs)}`
      )
      assert.isTrue(journal.logs.some((line) => line.includes("cd my-api && bun install")))
    }).pipe(Effect.provide(layer))
  })

  it.effect("reports a non-empty target as one sentence naming the directory", () => {
    const { journal, layer } = harness({ nonEmptyTarget: true })
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(run(["--name", "my-api", "--runtime", "node", "--pm", "npm"]))
      assert.strictEqual(exit._tag, "Failure")
      assert.deepStrictEqual(journal.writes, [])
      // The user must see a sentence naming the directory, not a bare tag and
      // a stack trace: assert on what's actually rendered, not just failure.
      const rendered = journal.errors.join("\n")
      assert.isTrue(
        rendered.includes("my-api already exists and is not empty"),
        `error output did not name the directory as one sentence: ${JSON.stringify(journal.errors)}`
      )
    }).pipe(Effect.provide(layer))
  })

  // `--print-dir` exists because a child process cannot change its parent's
  // working directory. The path on stdout is what makes `cd "$(...)"` work, so
  // stdout carrying exactly one line — and nothing else ever carrying one — is
  // the whole contract.
  it.effect("prints the absolute project path on stdout with --print-dir", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--print-dir"])
      assert.deepStrictEqual(journal.stdout, [resolve("my-api")])
    }).pipe(Effect.provide(layer))
  })

  it.effect("prints an absolute path, since the caller's cwd is not ours to assume", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--print-dir"])
      assert.isTrue(
        isAbsolute(journal.stdout[0] ?? ""),
        `stdout was not an absolute path: ${JSON.stringify(journal.stdout)}`
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("writes nothing to stdout without --print-dir", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm"])
      assert.deepStrictEqual(journal.stdout, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps the human output on stderr under --print-dir, not folded into stdout", () => {
    // The summary and next steps must still be shown — they are just not the
    // thing a command substitution captures.
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--print-dir"])
      assert.isTrue(
        journal.logs.some((line) => line.includes("Created my-api")),
        `the summary line vanished: ${JSON.stringify(journal.logs)}`
      )
      assert.strictEqual(journal.stdout.length, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("prints no path when the scaffold failed", () => {
    // A path on stdout means "this directory exists and is ready". Printing one
    // after a failure would make `cd "$(...)"` land somewhere that is not there.
    const { journal, layer } = harness({ nonEmptyTarget: true })
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(
        run(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--print-dir"])
      )
      assert.strictEqual(exit._tag, "Failure")
      assert.deepStrictEqual(journal.stdout, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps the install output off stdout under --print-dir", () => {
    // Otherwise npm's progress lands inside the `cd` argument. Asserted here
    // rather than in PackageManager.test.ts because the question is whether the
    // flag reaches the installer at all.
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm", "--print-dir"])
      assert.deepStrictEqual(journal.installs.map(([, , stdout]) => stdout), ["stderr"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("leaves the install output on the terminal without --print-dir", () => {
    const { journal, layer } = harness()
    return Effect.gen(function*() {
      yield* run(["--name", "my-api", "--runtime", "node", "--pm", "npm"])
      assert.deepStrictEqual(journal.installs.map(([, , stdout]) => stdout), [undefined])
    }).pipe(Effect.provide(layer))
  })
})
