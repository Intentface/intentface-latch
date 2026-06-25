# @intentface/latch-mcp

The MCP (Model Context Protocol) host for Latch — connect to MCP servers and expose their tools to agents, with per-tenant isolation and brokered auth.

## What it does

- **`createMcpHost`** — opens MCP server connections and surfaces their tools as agent tools. SSRF allowlist (`allowedHosts`) bounds which hosts a connection may reach; the server token/auth is brokered server-side and never reaches the model.
- **`createMcpConnections`** — a `ConnectionRegistry` over a set of declared MCP connections (static `bearer`/`header` token, or interactive `oauth`). OAuth connections expose a gated `connect_<name>` tool so an agent can ask the user to authorize mid-chat (and auto-resume).
- **`createMcpOAuth`** — the per-connection OAuth flow (authorize/callback/refresh), Vault-backed per caller. Supports **DCR** (dynamic client registration) and **pre-registered** clients (for providers without DCR — Google/GitHub/Slack).
- **`createOAuthDiscoveryFetch`** — normalizes non-conformant discovery docs from proxied servers (force `https`, strip trailing-slash issuer) so the SDK's strict RFC checks pass.

## Usage

```ts
import { createMcpConnections } from "@intentface/latch-mcp";

const connections = createMcpConnections<Principal>({
  callbackBaseUrl: `${baseURL}/api/latch/connections`,
  connections: connectionDefs, // { name: { url, auth, normalize? } }
});
```

## Where it fits

A connection source for `@intentface/latch-core`'s registry. The platform also exposes user-added (UI/Vault-stored) MCP connections via the same primitives.
