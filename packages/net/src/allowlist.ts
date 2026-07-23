/**
 * Positive host allowlist shared by hosts that gate outbound connections on a
 * per-tenant list (MCP servers, OpenAPI backends). Complements the SSRF
 * blocklist in ./ssrf.ts: the allowlist says which hosts a tenant may reach at
 * all; the blocklist rejects private/internal addresses regardless.
 */

/** True if `host` is permitted by the allowlist (exact, or `.suffix` subdomain). */
export function isHostAllowed(host: string, allowed: string[]): boolean {
  // Strip one trailing DNS dot: `URL.hostname` preserves it for a FQDN like
  // `api.example.com.`, which must match the same allowlist entries.
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    const a = entry.toLowerCase();
    if (a.startsWith(".")) return h === a.slice(1) || h.endsWith(a);
    return h === a;
  });
}
