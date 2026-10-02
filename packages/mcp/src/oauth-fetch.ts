/**
 * A custom fetch implementation, structurally compatible with the SDK's
 * `FetchFunction` (and `globalThis.fetch`). Declared locally so this package
 * doesn't take a direct dependency on `@ai-sdk/provider-utils`.
 */
export type FetchFunction = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * A fetch wrapper that canonicalizes a misbehaving MCP provider's OAuth
 * discovery documents so the SDK's strict RFC 8414 checks accept them.
 *
 * `@ai-sdk/mcp` enforces RFC 8414 exactly: the authorization-server metadata's
 * `issuer` must equal the issuer derived from the well-known URL it was fetched
 * from (origin, or origin+path, never with a trailing slash), and there is no
 * provider hook to relax it. Some providers — typically those behind a
 * TLS-terminating proxy — publish discovery documents that violate this:
 *
 *   • the protected-resource doc advertises its `authorization_servers` (and
 *     `resource`) over `http://` even though the live endpoints are `https://`;
 *   • the authorization-server doc's `issuer` carries a trailing slash
 *     (`https://host/`) while the SDK expects the bare origin (`https://host`).
 *
 * Either makes `auth()` throw `... issuer ... does not match expected issuer ...`.
 * This wrapper rewrites only the discovery documents (by well-known path), only
 * for the configured hosts, leaving every other request untouched. Wire it into
 * BOTH the OAuth flow (`McpOAuthConfig.fetch`) and the host transport
 * (`McpConnection.fetch`) so the on-401 re-auth/refresh uses it too.
 */
export interface OAuthDiscoveryFetchOptions {
  /** Underlying fetch. Default: `globalThis.fetch`. */
  baseFetch?: FetchFunction;
  /**
   * Force this scheme on the URLs inside discovery documents (issuer,
   * authorization/token/registration endpoints, advertised resource and
   * authorization servers). Use `"https"` for the common proxied-http case.
   * Omit to leave schemes as published. Never applied to loopback hosts
   * (`localhost`, `127.0.0.1`, `[::1]`): no TLS proxy fronts those, and
   * forcing https on a local http server breaks the SDK's resource check.
   */
  forceScheme?: "https" | "http";
  /**
   * Restrict normalization to these hostnames — a safety boundary so a third
   * party's metadata is never rewritten. Omit to apply to any host.
   */
  hosts?: string[];
}

/** No TLS-terminating proxy sits in front of these, so their schemes are left as published. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Well-known suffixes for the two discovery document kinds we touch. */
const PROTECTED_RESOURCE = "oauth-protected-resource";
const AUTH_SERVER = "oauth-authorization-server";
const OPENID = "openid-configuration";

/** Apply `forceScheme` to a URL string, returning it unchanged on parse failure. */
function withScheme(value: string, scheme?: "https" | "http"): string {
  if (!scheme || typeof value !== "string") return value;
  try {
    const u = new URL(value);
    if (u.protocol === `${scheme}:`) return value;
    u.protocol = `${scheme}:`;
    return u.toString();
  } catch {
    return value;
  }
}

/** Strip a single trailing slash so an issuer matches the SDK's bare-origin form. */
function stripTrailingSlash(value: string): string {
  return typeof value === "string" && value.endsWith("/")
    ? value.slice(0, -1)
    : value;
}

function normalizeProtectedResource(
  doc: Record<string, unknown>,
  scheme?: "https" | "http",
): Record<string, unknown> {
  const out = { ...doc };
  if (typeof out.resource === "string") {
    out.resource = withScheme(out.resource, scheme);
  }
  if (Array.isArray(out.authorization_servers)) {
    out.authorization_servers = out.authorization_servers.map((s) =>
      typeof s === "string" ? withScheme(s, scheme) : s,
    );
  }
  return out;
}

function normalizeAuthorizationServer(
  doc: Record<string, unknown>,
  scheme?: "https" | "http",
): Record<string, unknown> {
  const out = { ...doc };
  // The SDK's expected issuer is always trailing-slash-free; canonicalize both
  // scheme and the slash so `assertMetadataIssuerMatches` succeeds.
  if (typeof out.issuer === "string") {
    out.issuer = stripTrailingSlash(withScheme(out.issuer, scheme));
  }
  for (const key of [
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
    "revocation_endpoint",
    "introspection_endpoint",
    "userinfo_endpoint",
    "jwks_uri",
  ]) {
    if (typeof out[key] === "string") {
      out[key] = withScheme(out[key] as string, scheme);
    }
  }
  return out;
}

export function createOAuthDiscoveryFetch(
  options: OAuthDiscoveryFetchOptions = {},
): FetchFunction {
  const base = options.baseFetch ?? (globalThis.fetch as FetchFunction);
  const hosts = options.hosts?.map((h) => h.toLowerCase());

  return async (input, init) => {
    const response = await base(input, init);

    let url: URL;
    try {
      url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url,
      );
    } catch {
      return response;
    }

    // Only touch successful discovery documents on permitted hosts.
    if (!response.ok) return response;
    if (hosts && !hosts.includes(url.hostname.toLowerCase())) return response;

    const path = url.pathname;
    const isProtectedResource = path.includes(PROTECTED_RESOURCE);
    const isAuthServer = path.includes(AUTH_SERVER) || path.includes(OPENID);
    if (!isProtectedResource && !isAuthServer) return response;

    let doc: unknown;
    try {
      doc = await response.clone().json();
    } catch {
      return response; // not JSON — leave as-is
    }
    if (typeof doc !== "object" || doc === null) return response;

    // Trailing-slash cleanup applies everywhere; the forced scheme does not
    // reach a local server, whose http address is exactly what it serves.
    const scheme = LOOPBACK.has(url.hostname.toLowerCase()) ? undefined : options.forceScheme;
    const normalized = isProtectedResource
      ? normalizeProtectedResource(doc as Record<string, unknown>, scheme)
      : normalizeAuthorizationServer(doc as Record<string, unknown>, scheme);

    // Preserve status/headers; replace only the body.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
