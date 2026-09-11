import { defineConfig } from "vitest/config";

/**
 * Package tests run from each package dir (`pnpm --filter <pkg> test`). Vitest
 * walks UP for a config, so when this repo is vendored inside a host (e.g. as a
 * git submodule under `vendor/`) it would otherwise pick up the host's config
 * — whose `include` never matches a package's `src` tree — and report "No test
 * files found". Pin the defaults here so the packages test the same way
 * standalone and vendored.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
