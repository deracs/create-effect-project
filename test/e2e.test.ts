// This file is the one deliberate exception to the no-platform-imports constraint: it uses
// node:child_process, node:fs, node:os, node:path, node:url because it is a harness driving the
// CLI as a subprocess, not application code.
import { assert, describe, it } from "@effect/vitest"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const binPath = join(repoRoot, "src", "bin.ts")

const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0

/** Polls any URL until it answers, for servers that have no /health route. */
const waitForOk = async (url: string, timeoutMs: number): Promise<Response> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = new Error(`status ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${url} never became ready: ${String(lastError)}`)
}

/**
 * The workspace hoists its binaries to the root, but a package manager is free
 * to place them beside the app instead, so look in both.
 */
const binIn = (projectDir: string, app: string, name: string): string => {
  const candidates = [
    join(projectDir, "apps", app, "node_modules", ".bin", name),
    join(projectDir, "node_modules", ".bin", name)
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) throw new Error(`${name} is not installed: looked in ${candidates.join(", ")}`)
  return found
}

const waitForHealth = async (port: number, timeoutMs: number): Promise<Response> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/health`)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`server never became ready: ${String(lastError)}`)
}

type Runtime = "node" | "bun"

interface Variant {
  readonly runtime: Runtime
  readonly packageManager: "npm" | "bun"
  /** How to execute a TypeScript entrypoint directly under this runtime. */
  readonly exec: (entry: string) => readonly [string, ReadonlyArray<string>]
}

const variants: ReadonlyArray<Variant> = [
  {
    runtime: "node",
    packageManager: "npm",
    exec: (entry) => ["node", ["--experimental-strip-types", entry]]
  },
  {
    runtime: "bun",
    packageManager: "bun",
    exec: (entry) => ["bun", [entry]]
  }
]

/** Scaffolds into a fresh temp directory and asserts the CLI succeeded. */
const scaffold = (options: {
  readonly name: string
  readonly template: string
  readonly variant: Variant
  readonly extraFlags?: ReadonlyArray<string>
}) => {
  const workDir = mkdtempSync(join(tmpdir(), `cea-${options.template}-${options.variant.runtime}-`))
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      binPath,
      "--name",
      options.name,
      "--template",
      options.template,
      "--runtime",
      options.variant.runtime,
      // Passed explicitly: a node project prompts for the package manager when
      // --pm is omitted, and there is no terminal here to answer.
      "--pm",
      options.variant.packageManager,
      "--no-git",
      ...(options.extraFlags ?? [])
    ],
    { cwd: workDir, encoding: "utf8", timeout: 480_000 }
  )
  assert.strictEqual(result.status, 0, `scaffold failed: ${result.stderr}`)
  return { workDir, projectDir: join(workDir, options.name) }
}

/** Runs one of the generated project's npm scripts and asserts it exited 0. */
const script = (projectDir: string, name: string) => {
  const result = spawnSync("npm", ["run", name], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 480_000
  })
  assert.strictEqual(
    result.status,
    0,
    `${name} failed: ${result.stdout}${result.stderr}`
  )
  return result
}

/** Every template must produce an installable, type-correct, tested project. */
const assertProjectIsSound = (projectDir: string, name: string) => {
  const manifest = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
  assert.strictEqual(manifest.name, name)
  // The lint feature is on by default, so its patch must have merged.
  assert.strictEqual(manifest.scripts.lint, "oxlint src")
  assert.isDefined(manifest.devDependencies.oxlint)

  script(projectDir, "typecheck")
  // The generated code must satisfy the linter the generator configured for it.
  script(projectDir, "lint")

  const test = spawnSync("npm", ["test"], { cwd: projectDir, encoding: "utf8", timeout: 480_000 })
  assert.strictEqual(test.status, 0, `generated tests failed: ${test.stdout}${test.stderr}`)
}

describe("http-server template end to end", () => {
  const ports: Record<Runtime, number> = { node: 4901, bun: 4902 }

  for (const variant of variants) {
    const maybe = variant.runtime === "bun" && !hasBun ? it.skip : it

    maybe(`scaffolds a ${variant.runtime} project that installs, typechecks, tests and serves`, async () => {
      const { projectDir, workDir } = scaffold({ name: "my-api", template: "http-server", variant })
      const port = ports[variant.runtime]
      let server: ReturnType<typeof spawn> | undefined

      try {
        assertProjectIsSound(projectDir, "my-api")

        const [cmd, args] = variant.exec("src/index.ts")
        server = spawn(cmd, [...args], {
          cwd: projectDir,
          env: { ...process.env, PORT: String(port) },
          stdio: "ignore"
        })

        const health = await waitForHealth(port, 60_000)
        assert.strictEqual(health.status, 204)

        const created = await fetch(`http://127.0.0.1:${port}/notes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "first", body: "hello" })
        })
        assert.strictEqual(created.status, 200)
        const note = await created.json() as { id: string; title: string }
        assert.strictEqual(note.title, "first")

        const fetched = await fetch(`http://127.0.0.1:${port}/notes/${note.id}`)
        assert.strictEqual(fetched.status, 200)

        const missing = await fetch(`http://127.0.0.1:${port}/notes/nope`)
        assert.strictEqual(missing.status, 404)

        const openapi = await fetch(`http://127.0.0.1:${port}/openapi.json`)
        assert.strictEqual(openapi.status, 200)

        const docs = await fetch(`http://127.0.0.1:${port}/docs`)
        assert.strictEqual(docs.status, 200)
      } finally {
        server?.kill("SIGTERM")
        rmSync(workDir, { recursive: true, force: true })
      }
    })
  }
})

// A workspace, not a single package, so none of `assertProjectIsSound`'s
// assumptions hold: there is no `src/` at the root, and `typecheck` and `test`
// belong to the two apps rather than to the root manifest. Hence its own block.
describe("fullstack template end to end", () => {
  const apiPorts: Record<Runtime, number> = { node: 4911, bun: 4912 }
  const webPorts: Record<Runtime, number> = { node: 4913, bun: 4914 }

  for (const variant of variants) {
    const maybe = variant.runtime === "bun" && !hasBun ? it.skip : it

    maybe(`scaffolds a ${variant.runtime} workspace that installs, builds, typechecks, tests and renders`, async () => {
      const { projectDir, workDir } = scaffold({ name: "my-stack", template: "fullstack", variant })
      const apiPort = apiPorts[variant.runtime]
      const webPort = webPorts[variant.runtime]
      let api: ReturnType<typeof spawn> | undefined
      let web: ReturnType<typeof spawn> | undefined

      try {
        const root = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
        assert.strictEqual(root.name, "my-stack")
        assert.deepStrictEqual(root.workspaces, ["apps/*"])
        // The shared lint patch scripts `oxlint src`, which matches nothing here.
        // A regression to it would lint zero files and still exit 0, so assert the
        // override survived rather than trusting a green `lint`.
        assert.strictEqual(root.scripts.lint, "oxlint apps")
        script(projectDir, "lint")

        // Both halves must typecheck and pass their own tests. `apps/web`'s
        // `pretypecheck` runs `vite build` first, so this also proves the app
        // builds — this is the only template with a build step at all.
        for (const app of ["api", "web"] as const) {
          const appDir = join(projectDir, "apps", app)
          script(appDir, "typecheck")
          const test = spawnSync("npm", ["test"], { cwd: appDir, encoding: "utf8", timeout: 480_000 })
          assert.strictEqual(test.status, 0, `apps/${app} tests failed: ${test.stdout}${test.stderr}`)
        }

        // `pretypecheck` is a single line and easy to lose. Without it a fresh
        // clone cannot typecheck (no generated route tree) and the build quietly
        // stops being exercised here, with every other assertion still passing.
        for (const rel of ["dist/client", "dist/server/server.js"]) {
          assert.isTrue(
            existsSync(join(projectDir, "apps", "web", rel)),
            `the web build produced no ${rel}`
          )
        }

        // The claim this template shares with the other Notes templates: identical
        // domain, service and API definition, only relocated under the workspace.
        const templatesDir = fileURLToPath(new URL("../templates", import.meta.url))
        const sharedPairs = [
          ["_shared/notes/domain/Note.ts", "apps/api/src/domain/Note.ts"],
          ["_shared/notes/Notes.ts", "apps/api/src/server/Notes.ts"],
          ["_shared/httpapi/api/Api.ts", "apps/api/src/api/Api.ts"]
        ]
        for (const [from, to] of sharedPairs) {
          assert.strictEqual(
            readFileSync(join(projectDir, to!), "utf8"),
            readFileSync(join(templatesDir, from!), "utf8"),
            `${to} does not match the shared source ${from}`
          )
        }

        // The point of the workspace: the browser imports the API definition
        // through the package's `exports`, so one definition is checked on both
        // sides at compile time. A relative import would typecheck just as well
        // and quietly break that guarantee.
        const atoms = readFileSync(join(projectDir, "apps", "web", "src", "atoms", "NotesApi.ts"), "utf8")
        assert.include(
          atoms,
          `@my-stack/api/api`,
          "the web app does not import the API through its package exports"
        )

        // Everything above proves the workspace compiles and bundles. None of it
        // proves a page renders: the web app's own test stubs HttpClient, so no
        // HTML is ever produced and a build that 500s on first request would
        // still pass. So boot both halves and fetch the page for real.
        const [apiCmd, apiArgs] = variant.exec("src/index.ts")
        api = spawn(apiCmd, [...apiArgs], {
          cwd: join(projectDir, "apps", "api"),
          env: { ...process.env, PORT: String(apiPort), WEB_ORIGIN: `http://localhost:${webPort}` },
          stdio: "ignore"
        })
        const health = await waitForHealth(apiPort, 60_000)
        assert.strictEqual(health.status, 204)

        // Seed through the API, so what the page renders can only have come from
        // the server round trip.
        const seeded = await fetch(`http://127.0.0.1:${apiPort}/notes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "rendered-on-the-server", body: "hello" })
        })
        assert.strictEqual(seeded.status, 200)

        // `import.meta.env.VITE_API_URL` is baked in at build time, so the build
        // has to be re-run against this port rather than the 3000 default.
        const apiUrl = `http://localhost:${apiPort}`
        const built = spawnSync(binIn(projectDir, "web", "vite"), ["build"], {
          cwd: join(projectDir, "apps", "web"),
          env: { ...process.env, VITE_API_URL: apiUrl },
          encoding: "utf8",
          timeout: 480_000
        })
        assert.strictEqual(built.status, 0, `vite build failed: ${built.stdout}${built.stderr}`)

        // `preview` serves the built SSR server, so this exercises the artefacts
        // asserted above rather than a dev-mode approximation. It binds IPv6 by
        // default, hence the explicit --host.
        web = spawn(binIn(projectDir, "web", "vite"), [
          "preview",
          "--port",
          String(webPort),
          "--host",
          "127.0.0.1"
        ], { cwd: join(projectDir, "apps", "web"), stdio: "ignore" })

        const page = await waitForOk(`http://127.0.0.1:${webPort}/`, 90_000)
        const html = await page.text()

        // The note reached the markup, so the loader ran on the server and its
        // result was rendered — not fetched later in the browser.
        assert.include(
          html,
          "rendered-on-the-server",
          `the seeded note is not in the server-rendered HTML: ${html.slice(0, 400)}`
        )
        // And the dehydrated atom rode along, which is what lets the client
        // hydrate without issuing the request a second time.
        assert.include(
          html,
          "dehydratedAt",
          "the SSR payload carries no dehydrated atoms, so the client will refetch"
        )
        assert.include(html, "AtomHttpApi:notes:list", "the notes atom was not the one dehydrated")
      } finally {
        api?.kill("SIGTERM")
        web?.kill("SIGTERM")
        rmSync(workDir, { recursive: true, force: true })
      }
    })
  }
})

describe("basic template end to end", () => {
  for (const variant of variants) {
    const maybe = variant.runtime === "bun" && !hasBun ? it.skip : it

    maybe(`scaffolds a ${variant.runtime} project that installs, typechecks, tests and runs`, () => {
      const { projectDir, workDir } = scaffold({ name: "my-app", template: "basic", variant })

      try {
        assertProjectIsSound(projectDir, "my-app")

        // Unlike the server, this program must terminate on its own. A hang here
        // is the failure mode worth catching: `spawnSync` would hit the timeout.
        const [cmd, args] = variant.exec("src/main.ts")
        const run = spawnSync(cmd, [...args], {
          cwd: projectDir,
          encoding: "utf8",
          timeout: 120_000
        })
        assert.strictEqual(run.status, 0, `main.ts failed: ${run.stdout}${run.stderr}`)

        // Effect's default logger writes to stderr; take both streams.
        const output = `${run.stdout}${run.stderr}`
        assert.include(output, "created", `no "created" line in output: ${output}`)
        assert.include(output, "Ada", `the created user never reached the log: ${output}`)
        // Proves the typed error was raised AND handled, rather than crashing.
        assert.include(output, "handled", `UserNotFound was not handled: ${output}`)
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    })
  }
})

describe("cli template end to end", () => {
  for (const variant of variants) {
    const maybe = variant.runtime === "bun" && !hasBun ? it.skip : it

    maybe(`scaffolds a ${variant.runtime} project whose commands run and persist`, () => {
      const { projectDir, workDir } = scaffold({ name: "notes-cli", template: "cli", variant })

      try {
        assertProjectIsSound(projectDir, "notes-cli")

        const [cmd, args] = variant.exec("src/main.ts")
        // Each call is its own process, which is the whole point: the file-backed
        // layer exists because the shared in-memory one would forget between them.
        const cli = (...argv: ReadonlyArray<string>) =>
          spawnSync(cmd, [...args, ...argv], {
            cwd: projectDir,
            encoding: "utf8",
            timeout: 120_000
          })

        const empty = cli("list")
        assert.strictEqual(empty.status, 0, `list failed: ${empty.stdout}${empty.stderr}`)
        assert.include(`${empty.stdout}${empty.stderr}`, "No notes yet")

        const added = cli("add", "Buy milk", "--body", "2 litres")
        assert.strictEqual(added.status, 0, `add failed: ${added.stdout}${added.stderr}`)

        // A different process reading what the last one wrote. With
        // `Notes.layerMemory` this assertion is the one that fails.
        const listed = cli("list")
        assert.strictEqual(listed.status, 0, `list failed: ${listed.stdout}${listed.stderr}`)
        assert.include(`${listed.stdout}${listed.stderr}`, "Buy milk")

        const got = cli("get", "1")
        assert.strictEqual(got.status, 0, `get failed: ${got.stdout}${got.stderr}`)
        assert.include(`${got.stdout}${got.stderr}`, "2 litres")

        // The typed error has to reach the shell as a non-zero exit and a
        // sentence — a CLI that exits 0 on failure is worse than one that crashes.
        const missing = cli("get", "999")
        assert.strictEqual(missing.status, 1, "a missing note did not exit 1")
        const output = `${missing.stdout}${missing.stderr}`
        assert.include(output, "No note with id 999")
        assert.notInclude(output, "NoteNotFound", "the raw error tag leaked to the user")

        // `--help` is generated from the command definitions, so this also
        // proves the subcommands are actually registered.
        const help = cli("--help")
        assert.strictEqual(help.status, 0, `--help failed: ${help.stdout}${help.stderr}`)
        for (const subcommand of ["add", "list", "get"]) {
          assert.include(`${help.stdout}${help.stderr}`, subcommand)
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    })
  }
})

describe("ai template end to end", () => {
  for (const variant of variants) {
    const maybe = variant.runtime === "bun" && !hasBun ? it.skip : it

    // No API key here, and none in CI. What is proved is that the project
    // installs, typechecks, lints, and that its tests — which stub
    // `LanguageModel` rather than calling a provider — pass. `main.ts` needs a
    // real key, so it is not executed, the same as the alchemy templates.
    maybe(`scaffolds a ${variant.runtime} project that installs, typechecks and tests`, () => {
      const { projectDir, workDir } = scaffold({ name: "notes-ai", template: "ai", variant })

      try {
        assertProjectIsSound(projectDir, "notes-ai")

        const manifest = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
        // `AI_PROVIDER` picks between them at startup, so a project carrying
        // only one would crash on a configuration the template documents.
        assert.isDefined(manifest.dependencies["@effect/ai-anthropic"])
        assert.isDefined(manifest.dependencies["@effect/ai-openai"])

        const toolkit = readFileSync(join(projectDir, "src", "NotesToolkit.ts"), "utf8")
        // The handlers must call the shared service rather than reimplement it.
        assert.include(toolkit, "notes.create")
        assert.include(toolkit, "notes.getById")

        const model = readFileSync(join(projectDir, "src", "AiModel.ts"), "utf8")
        assert.include(model, "AnthropicLanguageModel")
        assert.include(model, "OpenAiLanguageModel")

        // Nothing outside AiModel.ts may name a provider — that is the claim
        // the template makes about `LanguageModel` being the seam.
        for (const file of ["main.ts", "NotesToolkit.ts", "NotesToolkit.test.ts"]) {
          const contents = readFileSync(join(projectDir, "src", file), "utf8")
          assert.notInclude(
            contents,
            "@effect/ai-anthropic",
            `${file} names a provider directly, so switching providers is not one file`
          )
          assert.notInclude(contents, "@effect/ai-openai", `${file} names a provider directly`)
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    })
  }
})

// Both alchemy templates deploy a Worker, so they share every check except
// which sources they must and must not emit.
const alchemyTemplates = [
  {
    id: "alchemy-http",
    name: "cf-api",
    present: ["src/worker.ts", "alchemy.run.ts", "src/api/Api.ts", "src/client/ApiClient.ts"],
    absent: ["src/index.ts", "src/rpc.ts"]
  },
  {
    id: "alchemy-rpc",
    name: "rpc-api",
    present: ["src/worker.ts", "alchemy.run.ts", "src/rpc.ts", "src/server/Notes/rpc.ts"],
    // RPC replaces the HttpApi rather than sitting alongside it.
    absent: ["src/index.ts", "src/api/Api.ts", "src/server/http.ts", "src/client/ApiClient.ts"]
  }
]

describe.each(alchemyTemplates)("$id template end to end", (template) => {
  for (const variant of variants) {
    const maybe = variant.runtime === "bun" && !hasBun ? it.skip : it

    maybe(`scaffolds a ${variant.runtime} project that installs, typechecks, lints and tests`, () => {
      // Deliberately stops short of `alchemy deploy`: that needs a Cloudflare
      // account, so CI cannot verify it. Everything up to the deploy boundary is
      // covered, and the deploy path is NOT — do not read this as proof of it.
      const { projectDir, workDir } = scaffold({ name: template.name, template: template.id, variant })

      try {
        assertProjectIsSound(projectDir, template.name)

        // A Worker and a stack, not a port-bound server.
        for (const rel of template.present) {
          assert.isTrue(existsSync(join(projectDir, rel)), `${template.id}: missing ${rel}`)
        }
        for (const rel of template.absent) {
          assert.isFalse(existsSync(join(projectDir, rel)), `${template.id}: unexpected ${rel}`)
        }
        // Declines otel, so there must be no stub nothing imports.
        assert.isFalse(
          existsSync(join(projectDir, "src", "observability.ts")),
          `${template.id} emitted an observability.ts that nothing imports`
        )

        const manifest = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
        for (const script of ["deploy", "plan", "destroy", "tail"]) {
          assert.isDefined(manifest.scripts[script], `no ${script} script`)
        }
        assert.isDefined(manifest.dependencies.alchemy, "alchemy is not a dependency")

        // The claim these templates make: identical domain and business logic to
        // the local-server template, only the transport differs. Asserted against
        // the shipped sources rather than a fixture.
        const templatesDir = fileURLToPath(new URL("../templates", import.meta.url))
        const sharedPairs = [
          ["_shared/notes/domain/Note.ts", "src/domain/Note.ts"],
          ["_shared/notes/Notes.ts", "src/server/Notes.ts"],
          ["_shared/config.ts", "src/config.ts"]
        ]
        for (const [from, to] of sharedPairs) {
          assert.strictEqual(
            readFileSync(join(projectDir, to!), "utf8"),
            readFileSync(join(templatesDir, from!), "utf8"),
            `${to} does not match the shared source ${from}`
          )
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    })
  }
})

describe("--print-dir end to end", () => {
  // Node only: the flag is runtime-independent, and the point of the case is
  // what reaches the two real streams of a real process — which a unit test
  // with a fake `Console` cannot show.
  it("puts the project path on stdout and everything else on stderr", () => {
    // `realpathSync` because on macOS `tmpdir()` is a symlink (/var -> /private/var)
    // and the CLI resolves against its actual working directory, which is right.
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), "cea-print-dir-")))

    try {
      // Installing on purpose: the package manager writes to stdout by default,
      // and a progress bar landing in a command substitution would end up inside
      // the `cd` argument. That is the regression this case exists for.
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          binPath,
          "--name",
          "printed-app",
          "--template",
          "basic",
          "--runtime",
          "node",
          "--pm",
          "npm",
          "--no-git",
          "--print-dir"
        ],
        { cwd: workDir, encoding: "utf8", timeout: 480_000 }
      )
      assert.strictEqual(result.status, 0, `scaffold failed: ${result.stderr}`)

      // Exactly one line, and it is the directory — this is what `cd "$(...)"`
      // receives verbatim.
      assert.strictEqual(
        result.stdout,
        `${join(workDir, "printed-app")}\n`,
        `stdout was not exactly the project path: ${JSON.stringify(result.stdout)}`
      )
      assert.isTrue(existsSync(join(workDir, "printed-app", "package.json")))

      // The human output is not lost, only moved: a silent minute during an
      // install is what showing it was meant to prevent.
      assert.include(result.stderr, "Created printed-app")
      assert.include(result.stderr, "Installing dependencies")
      // The install actually ran and its output went to the other stream.
      assert.isTrue(existsSync(join(workDir, "printed-app", "node_modules")))
      assert.include(result.stderr, "packages", `npm's own output did not reach stderr: ${result.stderr}`)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})

describe("--slop oxlint rules end to end", () => {
  // Node only, deliberately: the rules live in .oxlintrc.json and are
  // runtime-independent, so a second install buys nothing.
  const variant: Variant = {
    runtime: "node",
    packageManager: "npm",
    exec: (entry) => ["node", ["--experimental-strip-types", entry]]
  }

  it("adds rules that reject slop but leave the generated code clean", () => {
    const { projectDir, workDir } = scaffold({
      name: "slop-app",
      template: "basic",
      variant,
      extraFlags: ["--slop"]
    })

    try {
      const config = JSON.parse(readFileSync(join(projectDir, ".oxlintrc.json"), "utf8"))
      assert.strictEqual(config.rules["typescript/no-explicit-any"], "error")

      // The rules must not fight the code the generator just wrote.
      script(projectDir, "lint")

      // ...but they must actually fire. Without this the config could be inert
      // and every other assertion here would still pass.
      writeFileSync(
        join(projectDir, "src", "sloppy.ts"),
        [
          "// @ts-ignore",
          "export const bad = (input: any) => {",
          "  console.log(input!.x)",
          "  if (input) { return 1 } else { return 2 }",
          "}",
          ""
        ].join("\n")
      )
      const dirty = spawnSync("npm", ["run", "lint"], {
        cwd: projectDir,
        encoding: "utf8",
        timeout: 120_000
      })
      assert.notStrictEqual(dirty.status, 0, "slop rules did not reject obviously sloppy code")
      const output = `${dirty.stdout}${dirty.stderr}`
      for (const rule of ["no-explicit-any", "ban-ts-comment", "no-non-null-assertion", "no-console"]) {
        assert.include(output, rule, `${rule} did not fire`)
      }

      // The control: the same file passes once the slop rules are removed, which
      // proves the findings come from --slop and not the base correctness set.
      const { rules, ...withoutSlop } = config
      writeFileSync(join(projectDir, ".oxlintrc.json"), JSON.stringify(withoutSlop, null, 2))
      const clean = spawnSync("npm", ["run", "lint"], {
        cwd: projectDir,
        encoding: "utf8",
        timeout: 120_000
      })
      assert.strictEqual(
        clean.status,
        0,
        `the same file failed without the slop rules, so they are not what caught it: ${clean.stdout}${clean.stderr}`
      )
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
