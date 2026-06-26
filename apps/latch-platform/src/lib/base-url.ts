/**
 * The app's canonical public origin (no trailing slash) — the single source of
 * truth used by auth (baseURL + trusted origins), the MCP/connection OAuth
 * callback base, and the Slack manifest/redirect URLs. Resolution order:
 *   PUBLIC_BASE_URL → BETTER_AUTH_URL → https://$VERCEL_PROJECT_PRODUCTION_URL → localhost
 * Set PUBLIC_BASE_URL (or BETTER_AUTH_URL) to a custom domain in production.
 */
export function baseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL ?? process.env.BETTER_AUTH_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? `https://${prod}` : "http://localhost:3000";
}
