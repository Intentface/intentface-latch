import type { McpConnectionDef } from "@intentface/latch-mcp";
import loredex from "./loredex";
import googleCalendar from "./google-calendar";

/**
 * The platform's MCP connections, keyed by name. Add a file under `connections/`
 * and register it here — the framework derives the OAuth routes, tools, and
 * status from the set. A connection with no configured URL/credentials is omitted.
 * The key is the connection name (and its OAuth callback path segment).
 */
export const connectionDefs: Record<string, McpConnectionDef> = {
  ...(loredex.url ? { loredex } : {}),
  // Google needs a pre-registered client (no DCR) — only load when configured.
  // Its own client (GOOGLE_CALENDAR_*), separate from the Google login client.
  ...(process.env.GOOGLE_CALENDAR_CLIENT_ID ? { google_calendar: googleCalendar } : {}),
};
