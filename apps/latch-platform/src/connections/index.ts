import type { McpConnectionDef } from "@intentface/latch-mcp";
import loredex from "./loredex";

/**
 * The platform's MCP connections, keyed by name. Add a file under `connections/`
 * and register it here — the framework derives the OAuth routes, tools, and
 * status from the set. A connection with no configured URL is omitted.
 */
export const connectionDefs: Record<string, McpConnectionDef> = {
  ...(loredex.url ? { loredex } : {}),
};
