// Packs the real tarball, installs it as a consumer would, and runs the installed
// binary.
//
// This exists because a whole class of defect is invisible until the package is
// installed. Shipping `bin: src/bin.ts` passed every unit and e2e test and was
// still completely broken: Node refuses to strip types for files under
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) at every version.
// Nothing that runs from the working tree can catch that. This can.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// `npm publish --dry-run` exports npm_config_dry_run=true, and every child
// process inherits it — which would make the `npm pack` below write no tarball
// and the consumer `npm install` install nothing, failing this script for a
// reason that has nothing to do with the package. This script always does the
// real thing, so drop the flag before spawning anything.
delete process.env.npm_config_dry_run

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
const binName = Object.keys(manifest.bin)[0]

const failures = []
const check = (ok, message) => {
  console.log(`  ${ok ? "✓" : "✗"} ${message}`)
  if (!ok) failures.push(message)
}

const run = (cmd, args, options) => {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 300_000,
    ...options
  })
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

const workDir = mkdtempSync(join(tmpdir(), "cep-pack-"))

/** Thrown to stop the run early; the failure is already recorded in `failures`. */
class Abort extends Error {}

try {
  console.log("\nbuilding the bundle")
  const build = run("npm", ["run", "build"], { cwd: repoRoot })
  check(build.status === 0, `build succeeded${build.status === 0 ? "" : `: ${build.output}`}`)
  // Everything downstream needs the bundle, but bail through the summary rather
  // than an unhandled throw, so the reason is the last thing printed.
  if (build.status !== 0) throw new Abort()

  const bundle = join(repoRoot, "dist", "bin.js")
  check(existsSync(bundle), "dist/bin.js exists")
  const contents = readFileSync(bundle, "utf8")
  const lines = contents.split("\n")
  check(lines[0] === "#!/usr/bin/env node", `bundle starts with a shebang (got ${JSON.stringify(lines[0])})`)
  // A duplicated shebang is easy to introduce: esbuild already preserves the
  // entry point's, so adding one via --banner produces two and the file will not
  // parse. Count them rather than only checking line 1, so the diagnostic points
  // at the cause instead of at a downstream "--version exited non-zero".
  const shebangs = lines.filter((line) => line.startsWith("#!")).length
  check(shebangs === 1, `bundle has exactly one shebang (found ${shebangs})`)

  console.log("\npacking")
  const pack = run("npm", ["pack", "--pack-destination", workDir], { cwd: repoRoot })
  check(pack.status === 0, "npm pack succeeded")
  const tarball = readdirSync(workDir).find((entry) => entry.endsWith(".tgz"))
  check(tarball !== undefined, "tarball produced")
  if (tarball === undefined) throw new Abort()

  console.log("\ninstalling as a consumer")
  const consumer = join(workDir, "consumer")
  run("mkdir", ["-p", consumer])
  run("npm", ["init", "-y"], { cwd: consumer })
  const install = run("npm", ["install", join(workDir, tarball)], { cwd: consumer })
  check(install.status === 0, `install succeeded${install.status === 0 ? "" : `: ${install.output}`}`)

  // The point of bundling: a consumer must not download effect (51MB unpacked)
  // and its native prebuild machinery just to scaffold.
  const installed = readdirSync(join(consumer, "node_modules")).filter((entry) => !entry.startsWith("."))
  check(
    installed.length === 1 && installed[0] === manifest.name,
    `consumer installed only ${manifest.name} (got: ${installed.join(", ") || "nothing"})`
  )

  const bin = join(consumer, "node_modules", ".bin", binName)
  check(existsSync(bin), `bin/${binName} was linked`)

  console.log("\nrunning the installed binary")
  const version = run(bin, ["--version"], { cwd: consumer })
  check(version.status === 0, `--version exited 0${version.status === 0 ? "" : `: ${version.output}`}`)
  check(
    version.output.includes(manifest.version),
    `--version reports ${manifest.version} (got: ${version.output.trim()})`
  )

  const help = run(bin, ["--help"], { cwd: consumer })
  check(help.status === 0, "--help exited 0")
  check(help.output.includes(binName), "--help names the published binary, not a stale one")

  // Every template must scaffold from the installed package, which proves
  // templates/ shipped in the tarball and that templateRoot resolves from dist/.
  // One distinctive file per template, so a template that shipped without its
  // own sources fails here rather than passing on package.json alone.
  const templates = [
    { id: "http-server", entry: "src/index.ts" },
    { id: "fullstack", entry: "apps/api/src/index.ts" },
    { id: "basic", entry: "src/main.ts" },
    { id: "cli", entry: "src/commands.ts" },
    { id: "ai", entry: "src/NotesToolkit.ts" },
    { id: "alchemy-http", entry: "src/worker.ts" },
    { id: "alchemy-rpc", entry: "src/rpc.ts" }
  ]
  for (const template of templates) {
    const name = `smoke-${template.id}`
    const scaffold = run(
      bin,
      ["--name", name, "--template", template.id, "--runtime", "node", "--pm", "npm", "--no-install", "--no-git"],
      { cwd: consumer }
    )
    check(
      scaffold.status === 0,
      `${template.id} scaffolded${scaffold.status === 0 ? "" : `: ${scaffold.output}`}`
    )
    check(
      existsSync(join(consumer, name, template.entry)),
      `${template.id} wrote ${template.entry}`
    )
    check(
      existsSync(join(consumer, name, "package.json")),
      `${template.id} wrote package.json`
    )
  }
} catch (error) {
  if (!(error instanceof Abort)) throw error
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

console.log("")
if (failures.length > 0) {
  console.error(`packaged-install smoke test FAILED (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log("packaged-install smoke test passed")
