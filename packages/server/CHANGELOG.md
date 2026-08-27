# @intentface/latch-server

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
