# @intentface/latch-mcp

## 0.6.0

### Minor Changes

- 6c38f2f: Approval policy can now see call arguments. A connection's `approval` predicate may return, instead of a boolean, a per-call function `(input) => boolean | Promise<boolean>` — evaluated by the AI SDK with the model's arguments each time the tool is called. This is the escape hatch for meta-tool servers (one `execute_tool` multiplexing every operation through its arguments carries a single annotation set, so a per-tool boolean can only gate everything or nothing): gate `execute_tool` only when `input.toolName` starts with `create_`, and let the reads run free. Annotations remain the first-class, default signal. New exports: `McpCallApproval`, `mcpApprovalValue`. `needsMcpApproval`'s return type widens to `boolean | McpCallApproval` (a function is truthy, so existing truthiness checks stay conservative and correct).

### Patch Changes

- Updated dependencies [3721c48]
- Updated dependencies [8b9e1c8]
  - @intentface/latch-core@0.6.0
  - @intentface/latch-net@0.6.0

## 0.5.0

### Patch Changes

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
- @intentface/latch-core@0.5.0
  - @intentface/latch-net@0.5.0

## 0.4.1

### Patch Changes

- @intentface/latch-core@0.4.1
  - @intentface/latch-net@0.4.1

## 0.4.0

### Patch Changes

- @intentface/latch-core@0.4.0
  - @intentface/latch-net@0.4.0

## 0.3.1

### Patch Changes

- @intentface/latch-core@0.3.1
  - @intentface/latch-net@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ddfa57b]
  - @intentface/latch-core@0.3.0
  - @intentface/latch-net@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [194c789]
- Updated dependencies [c782ec9]
  - @intentface/latch-core@0.2.0
  - @intentface/latch-net@0.2.0

## 0.1.0

### Patch Changes

- b00e813: Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.
  
  These packages previously declared each other at an exact version, so installing two of
  them at different patch levels put a second copy of the shared package in `node_modules` —
  its own module registry, its own `instanceof` identities, and no error to say so. They now
  declare `^<version>`, which dedupes against the range in your own `package.json`.
  
  Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
  an earlier version produced.
- Updated dependencies [166c7a8]
  - @intentface/latch-core@0.1.0
  - @intentface/latch-net@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [9dd4f7a]
  - @intentface/latch-core@0.0.1
  - @intentface/latch-net@0.0.1
