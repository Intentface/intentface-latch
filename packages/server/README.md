# @intentface/latch-server

The mountable HTTP surface for a Latch runtime — **one framework-agnostic Web handler** you mount at a single route in any Web-standard host (TanStack Start, Next, Bun, Deno, serverless).

## What it does

`createLatchHandler({ runtime, connections, resolveContext })` returns a `(Request) => Response` handler that exposes the runtime over HTTP:

- `POST /agents/:agent/:id` — run a chat turn (streams UIMessage SSE).
- `POST /agents/:agent/:id/approvals` — submit HITL approval decisions (resumes the turn).
- `POST /agents/:agent/:id/tool-result` — return a client-handled tool result (e.g. `ask_question`).
- `GET /agents/:agent/:id/history`, `GET /chats`, `GET /runs` — projections for the UI.
- `GET/POST/DELETE /schedules` — manage scheduled agents; `POST /cron/run` — the host-guarded tick.
- `GET /connections`, `…/:name/authorize`, `…/:name/callback`, `…/:name/disconnect`, `…/test` — generic MCP connection OAuth + status.

`resolveContext(request)` turns a request into your `Principal` (bring-your-own auth). A Hono adapter is exported from the `/hono` subpath.

## OAuth callback identity

The connection callback is the one route that does NOT authenticate via
`resolveContext`. An IdP redirect arrives at a moment you don't control, so a
degraded session there must never decide where credentials land. Instead,
`authorize` pins the resolved principal into the OAuth flow state, and the
callback rebuilds it from that pin:

```ts
createLatchHandler<Principal>({
  runtime, connections, resolveContext,
  // Validate/re-hydrate the pinned identity on the callback (e.g. re-check
  // org membership). Null → 401. Default: trust the pin as-is.
  reconstructPrincipal: async (identity) => validateMembership(identity),
  oauthFlowMaxAgeMs: 30 * 60_000, // authorize → callback TTL (the default)
});
```

A callback whose pin is older than `oauthFlowMaxAgeMs` redirects with
`?error=flow_expired` (the user just re-runs connect). The pin is
tamper-evident — the full state string is exact-matched against the copy the
flow stored at `start()` — and principals are IDs-only by contract
(see `@intentface/latch-core`'s `principal.ts`), so nothing sensitive rides
in the URL.

## Usage

```ts
import { createLatchHandler } from "@intentface/latch-server";

const handler = createLatchHandler<Principal>({
  runtime, connections,
  resolveContext: (req) => getPrincipalFromHeaders(req.headers),
});
// mount at /api/latch/* — every Latch operation flows through this one handler.
```

## Where it fits

The HTTP tier over `@intentface/latch-core`. The routes are a convenience over the real contract — the Runtime operations — which you can still call directly from your own routes or non-HTTP triggers (cron, queues, chat channels).
