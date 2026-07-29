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
  // react/react-dom must resolve to ONE runtime copy: the nitro env's `_libs`
  // prebundle otherwise embeds its own react (used by react-dom's renderer)
  // while `_ssr` app chunks resolve another — a null hooks dispatcher at SSR
  // ("Cannot read properties of null (reading 'useCallback')"). traceDeps
  // externalizes them out of `_libs`; scripts/copy-server-deps.mjs ships the
  // packages so every bare import lands on the same node_modules copy.
  nitro: { traceDeps: ["@struktoai/mirage-node*", "react", "react-dom"] },
  // The `_ssr` service environment keeps Vite's default SSR externalization,
  // but nothing traces its externals into the deployed function — page SSR
  // then dies at runtime with "Cannot find module 'react'". Bundle the
  // react-free ones (react itself must stay external, see above; mirage-node
  // too).
  ssr: { noExternal: [/^better-auth/, /^framer-motion/, /^motion/] },
  plugins: [devtools(), tailwindcss(), tanstackStart(), nitro(), viteReact()],
})

export default config
