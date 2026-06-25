# @intentface/latch-openapi

Turn an **OpenAPI 3.x** document into agent tools — the "API without an MCP server" path. Each operation becomes a callable tool, no hand-written glue.

## What it does

- **`createOpenApiConnections` / `defineOpenApiConnection`** — fetch + dereference an OpenAPI spec and expose its operations as tools, scoped per connection. `operations.allow` restricts which operations are exposed.
- **SSRF allowlist** (`allowedHosts`) — bounds which hosts a connection may call (derived from the spec/base URLs).
- **Brokered auth** (`headers` / `apiKey` helpers) — inject the credential server-side (from the Vault); the token never reaches the model.

## Usage

```ts
import { createOpenApiConnections, defineOpenApiConnection, apiKey } from "@intentface/latch-openapi";

const openapi = createOpenApiConnections<Principal>({
  allowedHosts: ["api.example.com"],
  connections: {
    example: defineOpenApiConnection<Principal>({
      spec: "https://api.example.com/openapi.json",
      auth: apiKey({ header: "X-Api-Key", getKey: (p) => vault.get(p, "example_key", "org") }),
    }),
  },
});
```

## Where it fits

A connection source for `@intentface/latch-core`'s registry, alongside `@intentface/latch-mcp`. Merge them with `mergeConnections(...)`.
