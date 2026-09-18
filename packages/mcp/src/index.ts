/**
 * @intentface/latch-mcp
 *
 * MCP host for Latch: connect to MCP servers and surface their tools to an
 * agent, behind a per-tenant SSRF allowlist and vault-brokered auth. Built on
 * `@ai-sdk/mcp`; the resulting tools spread straight into an agent's `tools`.
 */
export {
  createMcpHost,
  isHostAllowed,
  buildAuthHeaders,
  needsMcpApproval,
  mcpApprovalValue,
  nameHeuristicApproval,
} from "./host.js";
export type {
  McpHost,
  McpHostConfig,
  McpConnection,
  McpAuth,
  McpApprovalPolicy,
  McpCallApproval,
  McpToolApprovalValue,
  McpToolInfo,
  NameHeuristicOptions,
  OpenMcp,
} from "./host.js";
export {
  createMcpOAuth,
  createVaultOAuthProvider,
  decodeOAuthState,
} from "./oauth.js";
export type { McpOAuth, McpOAuthConfig, StartResult } from "./oauth.js";
export { createOAuthDiscoveryFetch } from "./oauth-fetch.js";
export { createGuardedFetch, composeGuardedFetch } from "./guarded-fetch.js";
export type { GuardedFetch, GuardedFetchOptions } from "./guarded-fetch.js";
export type {
  OAuthDiscoveryFetchOptions,
  FetchFunction,
} from "./oauth-fetch.js";
export {
  createMcpConnections,
  defineMcpConnection,
  none,
  bearer,
  bearerHeader,
  headers,
  oauth,
} from "./connections.js";
export type {
  McpConnections,
  McpConnectionsConfig,
  McpConnectionDef,
  McpConnectionAuth,
  OAuthAuthOptions,
  ConnectionStatus,
} from "./connections.js";
