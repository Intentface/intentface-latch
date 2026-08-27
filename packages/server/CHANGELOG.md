# @intentface/latch-server

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
