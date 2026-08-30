// Reports template dependency pins that have fallen behind the registry.
//
// This exists because Dependabot and Renovate cannot see these pins at all.
// They scan files named `package.json`; the templates carry `_package.json`,
// underscore-prefixed so npm and git do not treat them as real manifests. So
// nothing upstream watches them, and staleness is invisible: the e2e installs
// whatever is pinned, it resolves, and CI stays green while the scaffolder ages.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const templatesDir = fileURLToPath(new URL("../templates", import.meta.url))
const strict = process.argv.includes("--strict")

/** Every manifest the templates emit, including the feature patches. */
const manifests = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (entry === "_package.json" || entry.endsWith("package.json")) manifests.push(full)
  }
}
walk(templatesDir)

/**
 * `{{workspaceVersion}}` and friends are placeholders the renderer fills in, not
 * versions to check.
 */
const isPlaceholder = (version) => version.startsWith("{{")

/**
 * Which dist-tag a pin should be compared against. A pin to a prerelease is
 * tracking that channel deliberately — `effect` pinned to an rc must be compared
 * against `rc`, since `latest` is still the v3 line and would report nonsense.
 */
const channelFor = (version) => {
  if (version.includes("-rc.")) return "rc"
  if (version.includes("-beta.")) return "beta"
  if (version.includes("-alpha.")) return "alpha"
  return "latest"
}

const pins = new Map()
for (const manifest of manifests) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"))
  } catch {
    continue
  }
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(parsed[field] ?? {})) {
      if (isPlaceholder(version)) continue
      if (!pins.has(name)) pins.set(name, new Set())
      pins.get(name).add(version)
    }
  }
}

const distTags = async (name) => {
  const response = await fetch(`https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`)
  if (!response.ok) throw new Error(`registry returned ${response.status}`)
  return response.json()
}

const rows = await Promise.all(
  [...pins].sort(([a], [b]) => a.localeCompare(b)).map(async ([name, versions]) => {
    const pinned = [...versions].sort()
    try {
      const tags = await distTags(name)
      // A range floats on install, so it is not stale in the way an exact pin is.
      // Report it, but never fail on it.
      const exact = pinned.filter((version) => /^\d/.test(version))
      // Not every project publishes prereleases under a matching tag — alchemy
      // ships its betas as `latest` and has no `beta` tag at all — so fall back
      // rather than reporting a blank.
      const preferred = channelFor(exact[0] ?? pinned[0])
      const channel = tags[preferred] === undefined ? "latest" : preferred
      const current = tags[channel]
      const behind = exact.length > 0 && current !== undefined && !exact.includes(current)
      return { name, pinned: pinned.join(", "), channel, current, behind, floating: exact.length === 0 }
    } catch (error) {
      return { name, pinned: pinned.join(", "), channel: "?", current: `lookup failed: ${error.message}`, behind: false, floating: false }
    }
  })
)

const behind = rows.filter((row) => row.behind)
const pad = (value, width) => String(value ?? "").padEnd(width)

console.log(`\n${pad("package", 32)}${pad("pinned", 26)}${pad("tag", 8)}current`)
console.log("-".repeat(84))
for (const row of rows) {
  const marker = row.behind ? " <- behind" : row.floating ? " (range)" : ""
  console.log(`${pad(row.name, 32)}${pad(row.pinned, 26)}${pad(row.channel, 8)}${row.current ?? "-"}${marker}`)
}

if (behind.length === 0) {
  console.log(`\nAll ${rows.length} exact pins match their channel.`)
  process.exit(0)
}

console.log(`\n${behind.length} of ${rows.length} pins are behind:`)
for (const row of behind) {
  console.log(`  ${row.name}: templates pin ${row.pinned}, ${row.channel} is ${row.current}`)
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning::${row.name} pins ${row.pinned} but ${row.channel} is ${row.current}`)
  }
}
// Default to reporting rather than failing: a pin lagging by a day is normal and
// should not turn the repo red. --strict is for when you want it to.
process.exit(strict ? 1 : 0)
