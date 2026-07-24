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
  plugins: [devtools(), tailwindcss(), tanstackStart(), nitro(), viteReact()],
})

export default config
