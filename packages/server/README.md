# @intentface/latch-server

The mountable HTTP surface for a Latch runtime — **one framework-agnostic Web handler** you mount at a single route in any Web-standard host (TanStack Start, Next, Bun, Deno, serverless).

## What it does

`createLatchHandler({ runtime, connections, resolveContext })` returns a `(Request) => Response` handler that exposes the runtime over HTTP:

- `POST /agents/:agent/:id` — run a chat turn (streams UIMessage SSE).
- `POST /agents/:agent/:id/approvals` — submit HITL approval decisions (resumes the turn).
- `POST /agents/:agent/:id/tool-result` — return a client-handled tool result (e.g. `ask_question`).
- `GET /agents/:agent/:id/history`, `GET /chats`, `GET /runs` — projections for the UI.
- `GET/POST/DELETE /schedules`, `GET /schedules/:id`, `POST /schedules/:id/run-now` — manage scheduled agents; `POST /cron/run` — the host-guarded tick.
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

The callback does **not** resume a waiting turn — the browser must not sit on a
blank page for a whole run. Resuming is the client's job after the redirect:
find the pending `connect_<name>` approval in the chat's history, submit it to
`POST /agents/:agent/:id/approvals`, and read the continuation stream that
returns. Two details are easy to miss: the continuation reuses the **last
assistant message's id** and streams only its new parts, so seed your stream
reader with a clone of that message or the answer renders as a second,
half-empty one; and mirror the decision locally first, or the approval card
stays on screen for the whole run. Reconcile against server history at the end.

A callback whose pin is older than `oauthFlowMaxAgeMs` redirects with
`?error=flow_expired` (the user just re-runs connect). The pin is
tamper-evident — the full state string is exact-matched against the copy the
flow stored at `start()` — and principals are IDs-only by contract
(see `@intentface/latch-core`'s `principal.ts`), so nothing sensitive rides
in the URL.

## Scheduling over HTTP

`POST /schedules` takes everything `runtime.schedule()` does, so the mounted
handler is not a reduced version of the contract:

```jsonc
{
  "agent": "briefer", "cron": "0 8 * * 1-5", "timezone": "Europe/Helsinki",
  "prompt": "morning brief",
  // Opaque to core — only your `runSchedule` hook reads it (a Slack thread, a DM).
  "delivery": { "kind": "slack", "appId": "A1", "channel": "C1" },
  // "skip" (default) = don't fire onto a predecessor still waiting on a human;
  // "fire" = always fire. An unknown value is a 400, never a silent default.
  "onParked": "fire"
}
```

`POST /schedules/:id/run-now` arms a schedule for the next tick rather than
firing it inline — it then goes through the ordinary `runDue` path (same claim,
same occurrence consume, same delivery), so "run now" cannot drift from what
the cron actually does. `GET /runs` deliberately omits each run's `identity`
(the serialized principal): it is durable server state and a type you are
invited to extend, so it never enters a browser payload — read it server-side
via `runtime.listRuns` if you need it.

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
