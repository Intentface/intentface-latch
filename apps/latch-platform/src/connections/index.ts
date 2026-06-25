import type { McpConnectionDef } from "@intentface/latch-mcp";
import googleCalendar from "./google-calendar";

/**
 * The platform's built-in MCP connections, keyed by name. Add a file under
 * `connections/` and register it here — the framework derives the OAuth routes,
 * tools, and status from the set. A connection with no configured URL/credentials
 * is omitted. The key is the connection name (and its OAuth callback segment).
 *
 * Connections referenced by an agent but NOT registered here are "late-bound":
 * they resolve to a user-defined connection of that name (added on the
 * Connections page) — e.g. `loredex` or `custom`.
 */
export const connectionDefs: Record<string, McpConnectionDef> = {
  // Google needs a pre-registered client (no DCR) — only load when configured.
  // Its own client (GOOGLE_CALENDAR_*), separate from the Google login client.
  ...(process.env.GOOGLE_CALENDAR_CLIENT_ID ? { google_calendar: googleCalendar } : {}),
};
