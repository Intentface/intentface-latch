---
"@intentface/latch-server": minor
"@intentface/latch-mcp": patch
---

The OAuth callback no longer derives identity from the live session. The
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
