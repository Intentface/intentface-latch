import { StrictMode, startTransition } from "react"
import { hydrateRoot } from "react-dom/client"
import { StartClient } from "@tanstack/react-start/client"

// A tab that outlives a deploy holds chunk URLs that no longer exist on the
// CDN, so its next lazy import 404s and crashes the page (Vercel Skew
// Protection in src/server.ts prevents most of this, but only within its
// max-age window and for the deployment the cookie currently pins). Vite
// reports every failed dynamic import here; reloading fetches the current
// chunk graph. The timestamp guard keeps a genuinely broken network from
// turning this into a reload loop.
window.addEventListener("vite:preloadError", (event) => {
  const RELOAD_LOOP_WINDOW_MS = 30_000
  const lastReloadAt = Number(sessionStorage.getItem("chunk-reload-at") ?? 0)
  if (Date.now() - lastReloadAt < RELOAD_LOOP_WINDOW_MS) return
  sessionStorage.setItem("chunk-reload-at", String(Date.now()))
  event.preventDefault()
  window.location.reload()
})

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>
  )
})
