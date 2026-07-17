import { defineConfig } from "vitest/config";

// Standalone vitest config: the app's vite.config.ts loads the TanStack Start
// plugin (router codegen, nitro), which unit tests must not boot.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
