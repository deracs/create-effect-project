# yieldit

[![npm](https://img.shields.io/npm/v/yieldit)](https://www.npmjs.com/package/yieldit)
[![license](https://img.shields.io/npm/l/yieldit)](LICENSE)

Scaffolds an [Effect](https://effect.website) v4 project on Node or Bun — an HttpApi server, a
full-stack app, a plain program, a command-line app, an AI agent with typed tools, or a Cloudflare
Worker.

```bash
npx yieldit
```

That prompts for everything. Pass flags instead and nothing prompts, so the same command works in
a terminal and in CI:

```bash
npx yieldit --name my-api  --template http-server --runtime bun
npx yieldit --name my-app  --template basic --runtime node --no-otel --no-lint
```

`bunx yieldit`, `pnpm dlx yieldit` and `yarn dlx yieldit` work the same way.

### Landing in the new project

A child process cannot change your shell's working directory, so the CLI cannot `cd` for you.
`--print-dir` puts the path on stdout and moves everything else — its own logging and the package
manager's install output — to stderr, which is enough for the shell to do it:

```bash
cd "$(npx yieldit --name my-app --template cli --runtime node --print-dir)"
```

The same flag is what makes the tool scriptable: a caller gets a machine-readable path instead of
scraping log lines for one.

## Templates

| `--template` | What you get |
| --- | --- |
| `http-server` | A schema-first `HttpApi`. One definition produces the server routes, an OpenAPI document at `/openapi.json`, Scalar docs at `/docs`, and a typed client checked against the server at compile time |
| `fullstack` | The same `HttpApi` behind both a server and a server-rendered React UI — a workspace whose TanStack Start frontend drives its data through Effect's own reactivity, hydrated from SSR |
| `basic` | A runnable program: a `Context.Service` with an in-memory layer, a branded id, a typed error, and a `main` that handles it. No server |
| `cli` | A command-line app over the same Notes service: subcommands, arguments, flags, prompts, generated `--help` and shell completions, and a typed error that becomes a clean exit code |
| `ai` | A language model given that same service as typed tools — Anthropic or OpenAI behind one `LanguageModel` layer, with tests that stub the model and need no API key |
| `alchemy-http` | The same `HttpApi` deployed to a Cloudflare Worker with [Alchemy](https://alchemy.run) — infrastructure as Effects, no `wrangler.toml` |
| `alchemy-rpc` | The same service exposed as typed RPC on a Worker, so typed errors cross the wire as themselves rather than as status codes |

Six of the seven serve the same Notes domain from identical source files, so switching template
changes how the service is reached — a port, a Worker, `argv`, a model's tool call — and nothing
else.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--name`, `-n` | prompted | Directory and package name |
| `--template`, `-t` | prompted | `http-server`, `fullstack`, `basic`, `cli`, `ai`, `alchemy-http` or `alchemy-rpc` |
| `--runtime` | prompted | `node` or `bun` |
| `--pm` | prompted (node) | `npm`, `pnpm`, `yarn` or `bun`. Bun projects use bun; node projects are asked, with the detected manager pre-selected |
| `--no-otel` | on | Skip OTLP logs, metrics and traces |
| `--no-lint` | on | Skip oxlint, the `@effect/tsgo` language service, and `.vscode/settings.json` |
| `--slop` | off | Add stricter oxlint rules that reject sloppy code (needs `--lint`) |
| `--no-install` | installs | Skip dependency installation |
| `--no-git` | initialises | Skip `git init` |
| `--print-dir` | off | Print the new project's absolute path to stdout and nothing else, so `cd "$(...)"` works |

## What you get

No build step — Node and Bun both execute TypeScript directly, so there is nothing between editing
a file and running it. (The `fullstack` template's web app is the exception; Vite builds it.)

Every template comes with tests that pass, a typecheck that passes, and a lint that passes, on
both runtimes. Whichever package manager you choose is used for the install *and* for the commands
the generated files document, so a pnpm project reads `pnpm run dev`, not `npm run dev`.

With `--lint` (the default) you also get the Effect language service, which reports Effect-specific
mistakes through `tsc` — a floating Effect fails `typecheck` rather than surviving to runtime — plus
the editor settings that make those diagnostics show up in VS Code.

## Requirements

Node 20+ to run the scaffolder. Generated projects ask for more in their own manifests: Node 22.6+
for native TypeScript execution, or Bun 1.3+.

## Contributing

See [docs/internals.md](docs/internals.md) for how the template registry works, how to add a
template, and how the package is built, tested and released. Notable changes are in
[CHANGELOG.md](CHANGELOG.md).

## License

MIT
