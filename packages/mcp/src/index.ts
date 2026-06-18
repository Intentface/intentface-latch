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
} from "./host.js";
export type {
  McpHost,
  McpHostConfig,
  McpConnection,
  McpAuth,
  OpenMcp,
} from "./host.js";
export {
  createMcpOAuth,
  createVaultOAuthProvider,
} from "./oauth.js";
export type { McpOAuth, McpOAuthConfig, StartResult } from "./oauth.js";
