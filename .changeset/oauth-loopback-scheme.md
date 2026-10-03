---
"@intentface/latch-mcp": patch
---

`createOAuthDiscoveryFetch({ forceScheme: "https" })` no longer rewrites a local server's discovery documents. Forcing https is for servers behind a TLS-terminating proxy that advertise `http://` addresses — but it applied to every host, so a local MCP server's `http://localhost:3011/mcp` came back as `https://…`, the SDK's resource check refused it ("Protected resource … does not match expected …"), and connecting failed with a bare "authorize failed". Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) keep their published scheme; the trailing-slash cleanup still applies everywhere.
