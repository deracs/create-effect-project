#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { readFileSync } from "node:fs"
import { root } from "./Cli.ts"
import { Git } from "./Git.ts"
import { PackageManager } from "./PackageManager.ts"

/**
 * Read rather than hardcoded, so `--version` cannot drift from the published
 * version. `../package.json` is the package root from both `src/bin.ts` in
 * development and `dist/bin.js` once bundled.
 */
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { readonly version: string }

const MainLayer = Layer.mergeAll(PackageManager.layer, Git.layer).pipe(
  Layer.provideMerge(NodeServices.layer)
)

root.pipe(
  Command.run({ version }),
  Effect.provide(MainLayer),
  NodeRuntime.runMain
)
