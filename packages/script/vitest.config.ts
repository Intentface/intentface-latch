import { defineConfig } from "vitest/config";

// Explicit config so vitest never walks up to an embedding repo's root config
// (this repo is consumed as a git submodule, e.g. under loredex's vendor/).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
