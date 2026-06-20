import { defineMcpConnection, oauth } from "@intentface/latch-mcp";

/**
 * Loredex knowledge base over MCP (OAuth, Authorization Code + PKCE).
 *
 * Everything declarative: the framework runs PKCE/DCR, stores tokens in the
 * Vault per tenant, injects them server-side, and exposes the generic
 * authorize/callback routes. `normalize` rewrites Loredex's proxied discovery
 * documents (http authorization-server ref + trailing-slash issuer) so the
 * SDK's strict RFC 8414 check accepts them.
 */
export default defineMcpConnection({
  url: process.env.LOREDEX_MCP_URL ?? "",
  description: "Loredex knowledge base — search the organization's documents.",
  auth: oauth({
    clientName: "Latch Platform",
    scopes: ["mcp:read", "mcp:write"],
    normalize: { forceScheme: "https", hosts: ["app.loredex.ai"] },
  }),
});
