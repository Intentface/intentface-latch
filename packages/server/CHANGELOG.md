# @intentface/latch-server

## 0.13.2

### Patch Changes

- Updated dependencies [dfe9b90]
  - @intentface/latch-core@0.13.2
  - @intentface/latch-mcp@0.13.2

## 0.13.1

### Patch Changes

- Updated dependencies [6fed7fa]
- Updated dependencies [a88de67]
- Updated dependencies [cf10a1c]
  - @intentface/latch-core@0.13.1
  - @intentface/latch-mcp@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [3b0dbfb]
- Updated dependencies [71630e1]
- Updated dependencies [80f1630]
- Updated dependencies [015e0a1]
- Updated dependencies [96013b6]
  - @intentface/latch-core@0.13.0
  - @intentface/latch-mcp@0.13.0

## 0.12.0

### Patch Changes

- 96cc9f7: Drop the AI SDK beta pin: both packages now declare `ai` as `>=7.0.0`, matching
  every other package in the repo.
  
  `latch-drizzle` and `latch-server` still declared `ai: ">=7.0.0-beta.178"` and
  dev-installed that exact beta, so a workspace install resolved two copies of
  `ai` — a beta for these two and a release for everyone else. Two copies in one
  process means two sets of error classes, so an `instanceof AISDKError` check
  across the boundary silently fails.
  
  No source change: the published code is byte-identical. Only the declared floor
  moves, from a prerelease nobody should still be on to the release line.
- Updated dependencies [e602c55]
  - @intentface/latch-core@0.12.0
  - @intentface/latch-mcp@0.12.0

## 0.11.0

### Minor Changes

- ae91f9c: MCP connections are address-guarded on every leg, and an unattended run no
  longer waives a connection's approval gates.
  
  Reported from a security review of a feature that lets any workspace member add
  an MCP server by URL — three problems a host application could not work around.
  
  **The OAuth legs had no address check at all.** An MCP server's
  protected-resource metadata *names* its authorization server, and Latch then
  fetched that server's metadata, registered a client with it, and posted to its
  token endpoint — following addresses the server operator chose, with no private-
  address check and with the SDK's errors (which quote the remote response body)
  reaching the member who added the connection. `McpOAuthConfig` had an
  `allowedAuthorizationServers` allowlist, but it failed open when unset *and* was
  never exposed on `oauth()`, so it could not be non-empty for any host.
  
  It is now exposed as `allowedAuthorizationServers` on `oauth()`, and **defaults
  to the MCP server's own origin**. A server that genuinely delegates to a
  separate IdP must declare it — the common case (a server that is its own
  authorization server) keeps working untouched. An empty array now allows
  nothing rather than everything.
  
  **The transport connected to an address nothing had vetted.** `host.open()`
  resolved a connection's hostname and rejected private ones, then handed the URL
  to `fetch`, which resolved it again: a name answering public to the check and
  private to the connect reached an internal service carrying the connection's
  credentials. Every connection now gets a fetch that vets inside the lookup its
  own socket uses (`createPinnedFetch`), used by the transport *and* by all OAuth
  legs, with redirects refused. A host-supplied `McpConnection.fetch` still wins —
  layer it over `createGuardedFetch` rather than over `globalThis.fetch`.
  
  `allowPrivateHost` relaxes both, per connection, so a trusted in-cluster server
  or a developer's `http://localhost:3999/mcp` is unaffected.
  
  `createMcpConnections` gains an optional `close()` that releases those fetches'
  keep-alive agents — a long-lived server never needs it; a test or short-lived
  process does.
  
  **Connection errors no longer quote the remote response.** The `authorize` and
  `test` routes returned `error.message`, which for OAuth failures embeds
  `Raw body: …`. They now return a stable code and at most an HTTP status; the
  full error goes to a new `onError` hook on the handler config.
  
  **An unattended run keeps source-contributed approval gates** (`latch-core`).
  `autoApprove` dropped the whole merged approval map, including the entries each
  opened connection contributed — which are not the agent's preference but the end
  user's choice about that connector. It now waives only the agent's own policy;
  a connection's or harness's gates survive and the turn parks instead. `blockGated`
  is unchanged and remains the opt-out, since it has already stubbed those tools.
  Scheduled fires were never affected: `runDue` has always used `autoApprove: false`.

### Patch Changes

- Updated dependencies [ae91f9c]
  - @intentface/latch-mcp@0.11.0
  - @intentface/latch-core@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [65d1de5]
- Updated dependencies [c70daf1]
  - @intentface/latch-core@0.10.0
  - @intentface/latch-mcp@0.10.0

## 0.9.1

### Patch Changes

- 8311508: Publish to the public npm registry.
  
  Installing no longer needs an `.npmrc`, a registry mapping or a token:
  `pnpm add @intentface/latch-core` just works. Every tarball now ships the MIT
  license text, and each manifest carries `keywords`, `homepage` and `bugs`.
  
  No code or API changes. The versions previously published to GitHub Packages
  stay where they are; new releases go to npm only.
- Updated dependencies [4b5e9eb]
- Updated dependencies [8311508]
- Updated dependencies [516d8f0]
- Updated dependencies [8fd120a]
  - @intentface/latch-core@0.9.1
  - @intentface/latch-mcp@0.9.1

## 0.9.0

### Minor Changes

- ebc0afd: One active run per chat, enforced in storage. `createRun` / `claimRun` throw
  `ChatBusyError` (code `chat_busy`, `retryAfterMs`) when the chat already has a
  live active run; the drizzle adapters back it with a partial unique index on
  `latch_runs (chat_id) WHERE status = 'active'` (both dialects; existing
  duplicates are marked `superseded` on migrate), and supersede an active run
  whose lease — or, for non-durable runs, a 10-minute stale window — has expired
  before opening the next, bumping its fencing token so the old worker's late
  writes are refused. `reclaimRun` returns null for a crashed run whose chat has
  since moved on. New optional `StorageAdapter.openTurn` opens the run and
  appends the user message in one transaction (the shipped adapters implement it;
  the SQLite adapter now uses real transactions on async drivers such as libsql),
  so a refused message leaves no trace and a crash can't leave a run without its
  message; the HTTP handler maps the refusal to 409 with
  `Retry-After`; the channel kernel renders it as "still working". Two tabs, a
  webhook retry racing a reply, or a schedule firing mid-conversation can no
  longer interleave one history — on every surface, not only in channels.
- d062dd2: One cron entry point and one non-streaming turn path.
  
  - `runtime.cron({ now?, maxAttempts? })` fires due schedules (`runDue`), then —
    with durability on — reaps lease-expired runs and resumes them (`sweep`).
    The phases are isolated: a failure in one lands in `errors` and the other
    still runs. Point every cron at this and nothing else. `tick()` is removed
    (it was `storage.reapExpiredRuns` behind a method); `runDue`, `sweep` and
    `resume` stay for callers that want the halves. `POST cron/run` on the
    handler now returns `cron()`'s result (`{ due, reaped, resumed, errors }`)
    instead of `runDue()`'s.
  - `runAgent`, `spawn_agent` and scheduled fires now share one internal
    `runToCompletion` path (previously three near-copies), so approval
    semantics, telemetry linkage and the "did it park?" verdict can't drift.
    Behaviour is unchanged; `runAgent`'s result shape is unchanged.
  - `runTurnStream` (the ephemeral, persist-nothing turn) is removed along with
    the `ephemeral` / `responseFormat: "text"` / `onComplete` branches inside the
    turn builder. Its only consumer was a smoke test. If you need a non-persisted
    turn, that belongs as an option on `handleChat`, not a second entry point.
  - Every tool's `options.context` now also carries `runtime` (the `Runtime`
    itself), so harness tools can schedule, list chats or spawn runs without a
    host-global.
- 78a40e3: One observation seam, and a callback that always identifies itself.
  
  - `RuntimeConfig.observability` (`onStep` / `onFinish` / `onError`) is folded
    into `LatchTelemetry`: `TelemetryRunMeta` gains `trigger` (what started the
    turn — `chat` / `decision` / `programmatic` / `schedule` / `resume`), and
    `LatchTelemetry` gains an optional `onStep(run, step)`. `onRunFinished`
    already covered `onFinish` and `onError` (status `"errored"` + the message).
    The two seams fired near-identical payloads at the same points; hosts now
    wire one object, and a tracer and plain callbacks compose instead of living
    in parallel. `TurnTrigger` moved to `telemetry.ts` (still exported from the
    package root).
  - Handler: `stateParams` and the legacy no-pin callback fallback are removed,
    and `resolveContext` loses its `extra` argument. Every flow the handler
    starts pins the resolved principal into the state; a callback without a pin
    is now rejected as `flow_expired` instead of asking the live session to
    stand in — the exact failure that once stored an org's tokens under a
    personal owner.
  - Fix: a turn whose model stream errored used to be settled as `completed`
    (the SDK still runs `onFinish` after `onError`) and reported to telemetry
    three times (`errored`, `errored`, `completed`). The first error now wins:
    one `errored` report, and the run row says `errored` with the message.
- 7d3c553: The last two pieces every host used to hand-write.
  
  - `@intentface/latch-core/harness`: the default harness tools — sandbox
    `bash`/`read_file`/`write_file`/`glob`/`grep` over the `sandbox` seam,
    `web_fetch` (clean markdown/text, images and PDFs as viewable media,
    SSRF-gated and DNS-pinned), `askUser` (client-handled pause), and
    `list_schedules`/`cancel_schedule` over `options.context.runtime`. Pass
    `harnessTools: defaultHarnessTools()`. `web_fetch`'s `turndown` and
    `@intentface/latch-net` are OPTIONAL peers of core, imported on first call.
    Lifted from latch-platform's sandbox/tools.ts + web-fetch.ts; the platform
    keeps only its policy (render_fetch, delivery-aware create_schedule, Slack
    tools).
  - `createLatchApp({ storage, agents, resolveContext })` in latch-server (and
    `createLatchHonoApp` on the hono subpath): the composition root with the
    defaults wired — durability on, croner cron evaluator, the models.dev
    catalog with pricing / reasoning / web-tool / prompt-caching hooks, the
    harness tools, the handler mounted, and an in-process `runtime.cron()`
    driver on long-running hosts (off on serverless). `agents` may be a
    function of the loaded catalog. Every default is overridable via
    `runtime` / `handler`. The example server is now ~30 lines of wiring.
- b22b3cf: Limits — per org / user / agent budgets on turns, tokens and cost.
  `createRuntime({ limits })` takes a `LatchLimits` seam: `limitsFor({ principal,
  agent, trigger })` names the counters a turn counts against and their caps
  (fixed, epoch-aligned windows), and a `LimitStore` holds the counters. The
  runtime refuses at admission with `LimitExceededError` (stable code
  `limit_exceeded`, `retryAfterMs`; the HTTP handler maps it to 429 with
  `Retry-After`), stops the tool loop once this turn's tokens reach the tightest
  remaining token budget, and settles tokens + cost on finish — resumes and
  subagent turns included. `runtime.cron()` prunes dead windows.
  `@intentface/latch-drizzle` adds `latch_limit_counters` (both dialects) and
  `createSqliteLimitStore` / `createPostgresLimitStore`.

### Patch Changes

- Updated dependencies [ebc0afd]
- Updated dependencies [d062dd2]
- Updated dependencies [8745142]
- Updated dependencies [cbbd775]
- Updated dependencies [78a40e3]
- Updated dependencies [7d3c553]
- Updated dependencies [b22b3cf]
  - @intentface/latch-core@0.9.0
  - @intentface/latch-mcp@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [e0e2000]
  - @intentface/latch-core@0.8.1
  - @intentface/latch-mcp@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [c5a64fd]
  - @intentface/latch-core@0.8.0
  - @intentface/latch-mcp@0.8.0

## 0.7.0

### Minor Changes

- fcef9d2: The mounted HTTP surface catches up with the runtime, and an unattended fire that parks is now reported.
  
  - `POST /schedules` forwards `delivery` and `onParked` (both were silently dropped, which made the whole `runSchedule` delivery seam unreachable through the handler); an unknown `onParked` is a 400 rather than a silent default.
  - New `GET /schedules/:id` (owner-scoped, 404 for anything not in the caller's own list) and `POST /schedules/:id/run-now`, which arms the schedule for the next tick so "run now" goes through the ordinary `runDue` path instead of drifting from it.
  - `GET /runs` no longer returns each run's `identity` — the serialized principal is durable server state and a customer type the docs invite you to extend, so it never enters a browser payload. Read it server-side via `runtime.listRuns`.
  - `runDue` returns a new `parked` count: fires that ran and then stopped waiting on a human (tokens spent, no answer delivered), logged on the tick it happens. Counted in `fired` too — the turn did run. This matters most for a one-shot schedule, which has no later occurrence for `onParked` to skip.
  - Docs: the callback route's "resume a waiting chat" comment was wrong (it redirects; resuming is the client's job) — corrected, and the client continuation protocol is now documented in the server README.

### Patch Changes

- Updated dependencies [fcef9d2]
- Updated dependencies [fcef9d2]
  - @intentface/latch-core@0.7.0
  - @intentface/latch-mcp@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [6c38f2f]
- Updated dependencies [3721c48]
- Updated dependencies [8b9e1c8]
  - @intentface/latch-mcp@0.6.0
  - @intentface/latch-core@0.6.0

## 0.5.0

### Minor Changes

- 9d1e453: The OAuth callback no longer derives identity from the live session. The
  authorize route pins the resolved principal into the flow state, and the
  callback rebuilds it from that pin — so a degraded session at redirect time
  (the classic: an active-org that is null on the callback request) can never
  store a connection's tokens under the wrong owner key.
  
  Server: new `reconstructPrincipal(identity, request)` config option to
  validate/re-hydrate the pinned identity on the callback (null → 401), and
  `oauthFlowMaxAgeMs` (default 30 min) — a staler pin redirects with
  `?error=flow_expired`. Threading identity through `stateParams` +
  `extra.oauthState` is deprecated (still works for legacy in-flight flows).
  
  MCP: `finish()` now deletes the spent CSRF state and PKCE verifier after a
  successful exchange (single-use flow state); a failed exchange leaves them so
  the flow stays retryable.

### Patch Changes

- Updated dependencies [9d1e453]
  - @intentface/latch-mcp@0.5.0
  - @intentface/latch-core@0.5.0

## 0.4.1

### Patch Changes

- @intentface/latch-core@0.4.1
  - @intentface/latch-mcp@0.4.1

## 0.4.0

### Patch Changes

- @intentface/latch-core@0.4.0
  - @intentface/latch-mcp@0.4.0

## 0.3.1

### Patch Changes

- @intentface/latch-core@0.3.1
  - @intentface/latch-mcp@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ddfa57b]
  - @intentface/latch-core@0.3.0
  - @intentface/latch-mcp@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [194c789]
- Updated dependencies [c782ec9]
  - @intentface/latch-core@0.2.0
  - @intentface/latch-mcp@0.2.0

## 0.1.0

### Patch Changes

- b00e813: Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.
  
  These packages previously declared each other at an exact version, so installing two of
  them at different patch levels put a second copy of the shared package in `node_modules` —
  its own module registry, its own `instanceof` identities, and no error to say so. They now
  declare `^<version>`, which dedupes against the range in your own `package.json`.
  
  Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
  an earlier version produced.
- Updated dependencies [b00e813]
- Updated dependencies [166c7a8]
  - @intentface/latch-mcp@0.1.0
  - @intentface/latch-core@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [9dd4f7a]
  - @intentface/latch-core@0.0.1
  - @intentface/latch-mcp@0.0.1
