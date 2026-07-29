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
  // Dev-only: let tunnel hostnames (ngrok/cloudflared, used for Telegram/
  // WhatsApp webhook testing) through Vite's host protection.
  server: { allowedHosts: [".ngrok-free.dev", ".ngrok-free.app", ".trycloudflare.com"] },
  // Keep mirage-node out of the server bundle: it loads tree-sitter .wasm and
  // several deps via runtime require, which only works from a real
  // node_modules layout. `traceDeps` externalizes it; the tracer misses its
  // dynamic-require edges, so scripts/copy-server-deps.mjs (postbuild) copies
  // the full dependency closure into the server output (plus the `_ssr`
  // service environment's runtime externals — react and friends).
  nitro: { traceDeps: ["@struktoai/mirage-node*"] },
  // The `_ssr` service environment keeps Vite's default SSR externalization,
  // but nothing traces its externals into the deployed function — page SSR
  // then dies at runtime with "Cannot find module 'react'". Bundle them
  // instead (mirage-node must stay external, see above).
  ssr: { noExternal: ["react", "react-dom", /^better-auth/, /^framer-motion/, /^motion/] },
  plugins: [devtools(), tailwindcss(), tanstackStart(), nitro(), viteReact()],
})

export default config
