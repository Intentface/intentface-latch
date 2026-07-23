/**
 * Positive host allowlist shared by hosts that gate outbound connections on a
 * per-tenant list (MCP servers, OpenAPI backends). Complements the SSRF
 * blocklist in ./ssrf.ts: the allowlist says which hosts a tenant may reach at
 * all; the blocklist rejects private/internal addresses regardless.
 */

/** True if `host` is permitted by the allowlist (exact, or `.suffix` subdomain). */
export function isHostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((entry) => {
    const a = entry.toLowerCase();
    if (a.startsWith(".")) return h === a.slice(1) || h.endsWith(a);
    return h === a;
  });
}
