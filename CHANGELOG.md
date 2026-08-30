# Changelog

Notable changes to `create-effect-project`. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [semantic versioning](https://semver.org/spec/v2.0.0.html).

The release workflow reads the section matching the tag it is publishing and
uses it as the GitHub Release notes, so a new version needs its heading here in
the form `## [x.y.z] - YYYY-MM-DD`.

## [Unreleased]

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
