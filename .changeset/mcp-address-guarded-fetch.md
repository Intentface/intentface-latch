---
"@intentface/latch-mcp": minor
"@intentface/latch-server": minor
"@intentface/latch-core": patch
---

MCP connections are address-guarded on every leg, and an unattended run no
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
