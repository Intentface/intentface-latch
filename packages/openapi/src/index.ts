/**
 * @intentface/latch-openapi
 *
 * OpenAPI connections for Latch: turn an OpenAPI 3.x document into agent tools
 * (one per operation), behind a per-tenant SSRF allowlist and brokered auth.
 * A second connection kind alongside MCP — the resulting `ConnectionRegistry`
 * merges with the MCP one (`mergeConnections` in core), so an agent's
 * `connections: [...]` resolves across both.
 */
export {
  defineOpenApiConnection,
  createOpenApiConnections,
} from "./connections.js";
export type {
  OpenApiConnectionDef,
  OpenApiConnectionsConfig,
} from "./connections.js";
export { bearer, apiKey, headers } from "./auth.js";
export type { OpenApiAuth } from "./auth.js";
export { isHostAllowed } from "./build.js";
export type { OpenApiApprovalPolicy, FetchFunction } from "./build.js";
