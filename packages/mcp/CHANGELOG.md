# @intentface/latch-mcp

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
  - @intentface/latch-core@0.11.0
  - @intentface/latch-net@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [65d1de5]
- Updated dependencies [c70daf1]
  - @intentface/latch-core@0.10.0
  - @intentface/latch-net@0.10.0

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
  - @intentface/latch-net@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [ebc0afd]
- Updated dependencies [d062dd2]
- Updated dependencies [8745142]
- Updated dependencies [cbbd775]
- Updated dependencies [78a40e3]
- Updated dependencies [7d3c553]
- Updated dependencies [b22b3cf]
  - @intentface/latch-core@0.9.0
  - @intentface/latch-net@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [e0e2000]
  - @intentface/latch-core@0.8.1
  - @intentface/latch-net@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [c5a64fd]
  - @intentface/latch-core@0.8.0
  - @intentface/latch-net@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [fcef9d2]
- Updated dependencies [fcef9d2]
  - @intentface/latch-core@0.7.0
  - @intentface/latch-net@0.7.0

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
