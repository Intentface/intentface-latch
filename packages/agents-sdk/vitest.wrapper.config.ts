/**
 * Runs the existing suite against loop-wrapper.ts instead of loop.ts.
 *
 * Only TEST files are redirected. loop-wrapper.ts itself imports helpers from
 * "./loop.js" and must keep resolving to the real module, and index.ts keeps
 * exporting the real loop.
 *
 *   pnpm exec vitest run --config vitest.wrapper.config.ts
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("./src/loop-wrapper.ts", import.meta.url));
const real = fileURLToPath(new URL("./src/loop.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^\.\/loop\.js$/,
        replacement: wrapper,
        customResolver(_source, importer) {
          return importer && /\.test\.ts$/.test(importer) ? wrapper : real;
        },
      },
    ],
  },
  test: { include: ["src/**/*.test.ts"] },
});
