# @intentface/latch-renderer

The Chromium half of `render_fetch`, in-repo. A stateless **render-once**
HTTP service: `GET /render?url=<https url>` loads the page in headless
Chromium (executes JavaScript), and returns the rendered visible text, any
schema.org JSON-LD (products, prices, offers), and page links.

The platform never runs Chromium in its own serverless function (native
binary + bundle limits) — this service deploys as a **Dockerfile container
function** and the platform's `render_fetch` app tool
([lib/render-fetch.ts](../../apps/latch-platform/src/lib/render-fetch.ts), wired in
[sandbox/tools.ts](../../apps/latch-platform/src/lib/sandbox/tools.ts) beside
`web_fetch`) calls it over HTTP.

## Layout

- `src/render.ts` — the browser core: launch, goto, wait, optional
  `waitFor`/`clickSelector`/`steps`/`scroll` interaction, extraction.
- `src/server.ts` — HTTP entry: `/render` + `/healthz`, auth, param
  validation. No spec endpoint — the only consumer is the platform's
  `render_fetch` tool, a plain HTTP client.
- `src/ssrf.ts` — host blocklist (private/loopback/encoded IPs) + DNS-rebinding
  resolved-IP check.
- `Dockerfile.vercel` — `node:22-slim` + Chromium headless shell only (the
  full Playwright image exceeds Vercel's per-layer limit).

## Deploy (Vercel)

Create a Vercel project from this repo with **Root Directory =
`packages/renderer`** — the `Dockerfile.vercel` is auto-detected and traffic
routes to the container. Then point the platform at it:

```
RENDER_FETCH_URL=https://<renderer-deployment>
RENDER_FETCH_TOKEN=<token>        # same value in both projects
```

Auth (header-only — `Authorization: Bearer` or `x-vercel-protection-bypass`):

- **Token set** → every request must present it.
- **Token unset, on Vercel** → the service **fails closed** (rejects all
  requests) unless `RENDER_FETCH_ALLOW_UNAUTHENTICATED=true` is set to
  acknowledge an edge-gated deploy — so a forgotten token can't silently turn
  this into a public browser-fetch proxy. When unset+acknowledged the token is
  effectively your Deployment Protection bypass secret.
- **Token unset, off Vercel (local dev)** → all requests allowed, for
  zero-config local runs.

## Local dev

```bash
pnpm --filter @intentface/latch-renderer install-browser   # once
pnpm --filter @intentface/latch-renderer dev               # :8787
pnpm --filter latch-platform dev   # render_fetch defaults to :8787 locally
```
