import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { nitro } from "nitro/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// `nitro/vite` is what makes TanStack Start deployable on Vercel: it detects the
// `VERCEL` build env and emits `.vercel/output` (a real serverless function),
// instead of the plain `dist/` that Vercel's static preset would 404 on.
const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Keep mirage-node out of the server bundle: it loads tree-sitter .wasm and
  // other deps via runtime require, which only works from a real node_modules
  // layout — `traceDeps` externalizes the package and traces its dep subtree
  // into .output/server/node_modules.
  // Keep mirage-node out of the server bundle: it loads tree-sitter .wasm and
  // several deps via runtime require, which only works from a real
  // node_modules layout. `traceDeps` externalizes it; the tracer misses its
  // dynamic-require edges, so scripts/copy-mirage-deps.mjs (postbuild) copies
  // the full dependency closure into the server output.
  nitro: { traceDeps: ["@struktoai/mirage-node*"] },
  plugins: [devtools(), tailwindcss(), tanstackStart(), nitro(), viteReact()],
})

export default config
