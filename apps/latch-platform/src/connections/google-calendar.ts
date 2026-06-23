import { defineMcpConnection, oauth } from "@intentface/latch-mcp";

/**
 * Google Calendar over MCP (OAuth, Authorization Code + PKCE).
 *
 * Google's auth server does NOT support Dynamic Client Registration, so we use a
 * PRE-REGISTERED OAuth client: create a "Web application" client in Google Cloud
 * Console and register the redirect URI
 *   <PUBLIC_BASE_URL>/api/latch/connections/google_calendar/callback
 * Then set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Tokens are stored per tenant
 * in the Vault and brokered server-side. Omitted (no client id) → not loaded.
 */
export default defineMcpConnection({
  url: process.env.GOOGLE_CALENDAR_MCP_URL ?? "https://calendarmcp.googleapis.com/mcp/v1",
  description: "Google Calendar — read and manage the user's calendar events.",
  auth: oauth({
    // Distinct from GOOGLE_CLIENT_ID (the better-auth Google *login* client) —
    // the Calendar MCP needs its own OAuth client with the calendar redirect
    // URI + scopes registered.
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    // The Calendar MCP server requires these SPECIFIC scopes (the broad
    // `auth/calendar` is rejected → "caller does not have permission"). They
    // must also be added to the OAuth consent screen's Data Access.
    scopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
  }),
});
