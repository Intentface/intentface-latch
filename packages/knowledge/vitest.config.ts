import { defineConfig } from "vitest/config";

// The Postgres tests run on PGlite (Postgres compiled to WASM, in process).
// The first test in each file starts it and runs every migration, which takes
// a few seconds on a busy CI runner: past vitest's 5 s default, it failed
// releases. 30 s is room for that start, not a limit any test should need.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
