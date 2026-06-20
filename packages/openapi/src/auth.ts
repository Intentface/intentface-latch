/**
 * Auth for OpenAPI connections — an opaque header resolver.
 *
 * The connection's auth is `(principal) => headers`: it runs server-side at call
 * time and returns the headers to attach to the outgoing request. Where the
 * credential comes from — and at what scope (per-user vs org-shared) — is the
 * caller's choice, expressed inside the resolver (e.g. reading the Vault at a
 * user- or org-scoped principal). The framework never sees the secret in agent
 * config, and it never reaches the model.
 */
export type OpenApiAuth<P> = (
  principal: P,
) => Record<string, string> | Promise<Record<string, string>>;

/** Bearer token → `Authorization: Bearer <token>`. */
export function bearer<P>(opts: {
  getToken: (principal: P) => string | undefined | Promise<string | undefined>;
}): OpenApiAuth<P> {
  return async (principal) => {
    const token = await opts.getToken(principal);
    const h: Record<string, string> = {};
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  };
}

/** API key in a named header (e.g. `X-Api-Key`). Missing key → no header (call likely 401s). */
export function apiKey<P>(opts: {
  header: string;
  getKey: (principal: P) => string | undefined | Promise<string | undefined>;
}): OpenApiAuth<P> {
  return async (principal) => {
    const key = await opts.getKey(principal);
    const h: Record<string, string> = {};
    if (key) h[opts.header] = key;
    return h;
  };
}

/** Static headers (no per-principal resolution). */
export function headers<P = unknown>(h: Record<string, string>): OpenApiAuth<P> {
  return () => ({ ...h });
}
