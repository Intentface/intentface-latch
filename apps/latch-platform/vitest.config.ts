import { defineConfig } from "vitest/config";

// Standalone vitest config: the app's vite.config.ts loads the TanStack Start
// plugin (router codegen, nitro), which unit tests must not boot.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
