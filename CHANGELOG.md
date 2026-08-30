# Changelog

Notable changes to `create-effect-project`. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [semantic versioning](https://semver.org/spec/v2.0.0.html).

The release workflow reads the section matching the tag it is publishing and
uses it as the GitHub Release notes, so a new version needs its heading here in
the form `## [x.y.z] - YYYY-MM-DD`.

## [Unreleased]

## [0.3.0] - 2026-08-31

### Added

- Two templates, bringing the count to seven:
  - `cli` — a command-line app over the same Notes service: subcommands,
    arguments, flags, prompts, generated `--help` and shell completions, and a
    typed error that becomes one sentence and exit 1. Carries a second
    implementation of the Notes service backed by a JSON file, because a CLI
    exits between commands and the shared in-memory layer would forget.
  - `ai` — a language model given that same service as a typed `Toolkit`.
    Anthropic or OpenAI behind one `LanguageModel` layer chosen by
    `AI_PROVIDER`, with tool parameters and results as schemas. Its tests stub
    the model with `LanguageModel.make`, so they need no API key and no network.
- `--print-dir` prints the new project's absolute path to stdout and nothing
  else, so `cd "$(create-effect-project ... --print-dir)"` works. A child
  process cannot change its parent shell's directory; this is what lets the
  shell do it. It also makes the CLI scriptable, since a caller gets a
  machine-readable path instead of scraping log lines for one.

### Fixed

- `src/config.ts` is no longer emitted by templates that never open a socket. It
  carries `port` and `baseUrl`, which meant nothing to `cli` or `ai` — an
  unimported file a reader has to work out is dead. There is now a test holding
  it to the same standard the observability stub is held to.

### Changed

- The packaged-install smoke test scaffolds every template rather than two, so a
  template whose sources failed to ship fails there instead of in someone's
  `npx`.
- Under `--print-dir`, the CLI's own logging moves to stderr
  (`Logger.LogToStderr`) and the package manager's output is piped there too.
  Effect's default logger writes to stdout, so without this the install progress
  would land inside the `cd` argument.

## [0.2.0] - 2026-08-31

### Added

- The package manager's own output is shown while installing. A large template
  takes the better part of a minute, and the CLI previously said nothing for the
  whole of it, which was indistinguishable from a hang. Every manager falls back
  to plain lines when stdout is not a TTY, so CI output stays readable.
- `npm run check:pins` reports template dependency pins that have fallen behind
  the registry, run weekly in CI. Dependabot and Renovate cannot see these pins:
  they scan files named `package.json`, and the templates carry `_package.json`.

### Changed

- Releases now create their GitHub Release automatically, after npm accepts the
  package, with notes taken from this file.

## [0.1.0] - 2026-08-30

First published release.

### Added

- Five templates, each on Node or Bun, each producing a project that installs,
  typechecks, lints and tests green:
  - `http-server` — a schema-first `HttpApi` with OpenAPI, Scalar docs and a
    typed client checked against the server at compile time
  - `fullstack` — the same `HttpApi` behind a server and a server-rendered
    TanStack Start UI, driven by Effect's own reactivity and hydrated from SSR
  - `basic` — a runnable program with a service, a branded id and a typed error
  - `alchemy-http` — the same `HttpApi` on a Cloudflare Worker via Alchemy
  - `alchemy-rpc` — the same service as typed RPC on a Worker
- Shared sources under `templates/_shared/`, so the four Notes templates emit
  byte-identical domain and business logic and differ only in transport.
- Optional OTLP observability (`--otel`), oxlint plus the `@effect/tsgo`
  language service (`--lint`), and a curated stricter rule set (`--slop`).
- Package-manager detection, with the chosen manager used for the install *and*
  for the commands the generated files document.
- Every flag promptable or passable, so the same binary works in a terminal and
  in CI.
