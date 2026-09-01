import { defineConfig } from "vitest/config"

// `exclude` still filters an explicitly-named file passed on the CLI, so `vitest run
// test/e2e.test.ts` alone would report "No test files found". The test:e2e script sets
// CEA_E2E=1 to swap the config: include only the e2e file, and stop excluding it.
const e2e = process.env.CEA_E2E === "1"

export default defineConfig({
  test: {
    include: e2e ? ["test/e2e.test.ts"] : ["test/**/*.test.ts"],
    exclude: e2e ? ["node_modules/**"] : ["test/e2e.test.ts", "node_modules/**"],
    testTimeout: e2e ? 600_000 : 20_000
  }
})
